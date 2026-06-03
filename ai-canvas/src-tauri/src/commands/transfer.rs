//! 项目「导出 / 导入」为可移植的 `.aicat` 文件。
//!
//! ## 这是什么
//!
//! 把一个项目打包成单个 `.aicat` 文件(本质是个 zip),可以拷给别人 / 备份 /
//! 跨设备迁移,再导入回来生成一个**全新的独立项目**。
//!
//! ## 包内结构
//!
//! ```text
//! manifest.json   元数据 + 版本 + 计数
//! canvas.json     { cards, connections, groups }  —— 仅画布,不含 chat/agent/tasks/settings
//! media/...       被卡片引用的本地媒体,按原相对路径(media/images/xxx.ext)真实拷贝
//! ```
//!
//! ## 几个关键决策
//!
//! - **画布-only**:只带 cards/connections/groups。chat/agent 会话、tasks 流水、
//!   全局 settings 都不进包(一份干净的画布快照)。
//! - **媒体按原路径打包、导入按原名落盘**:`media/images/{uuid}.{ext}` 是内容寻址的,
//!   全局唯一、跨项目共享,导入时同名即同内容 → 跳过即可,天然幂等、无需重命名。
//! - **导入时给 cards/connections/groups 全部换新 id**,并且**把 `card.data` 里
//!   内嵌的旧卡片 id 一并文本替换**。这是正确性核心:`card.data` 里到处是对别的
//!   卡片 id 的引用(`upstreamCardId` / `upstreamTexts` 的 key / `refImages[].sourceCardId`
//!   / `refFrames|refAudios|refVideos|directMedia[].sourceCardId` / `inlineRefs[]...`,
//!   详见 src/lib/referenceConsistency.ts)。若只换 connections 不换 data 里的 id,
//!   项目一加载就会被 `cleanupDanglingReferencesInCards` 当成悬空引用全部抹掉。
//! - **远程媒体不下载**:`card.data` 里的 http(s) 媒体保持 URL 原样(它在服务端)。
//!   换到访问不到该服务端的机器上这些图会裂 —— 这是当前取舍,后续可加「导出时内联」。
//! - **锁纪律**:重 IO(打/解包)走 `run_blocking` 且不持 db 锁;DB 读快照锁一次、
//!   导入入库另锁一次(事务内)。绝不在持锁时做文件 IO 或嵌套锁(见 AppState Mutex 不可重入)。

use crate::AppState;
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use tauri::State;
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use super::groups::{query_groups, upsert_group, CardGroupRow};
use super::project::{
    query_cards, query_connections, query_project_info, upsert_card, CardRow, ConnectionRow,
    ProjectInfo,
};
use super::util::run_blocking;

// ── 格式常量 ────────────────────────────────────────────────

/// 包格式版本。导入时若文件版本比这个新,直接拒绝(给用户「升级后再导入」提示)。
const FORMAT_VERSION: u32 = 1;
const MANIFEST_ENTRY: &str = "manifest.json";
const CANVAS_ENTRY: &str = "canvas.json";
/// 包内媒体目录前缀,与磁盘上的相对存储路径(`media/...`)保持一致。
const MEDIA_PREFIX: &str = "media/";

// ── 序列化结构 ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectMeta {
    title: String,
    thumbnail: Option<String>,
}

/// 导出/导入的统计。也是 `export_project` 回给前端的结果(展示「已导出 N 张卡片」等)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferCounts {
    cards: usize,
    connections: usize,
    groups: usize,
    media: usize,
    /// 引用了但磁盘上已找不到的媒体数(导出时跳过,不中断)。
    media_missing: usize,
}

#[derive(Debug, Serialize, Deserialize)]
struct Manifest {
    format_version: u32,
    app_version: String,
    exported_at: String,
    project: ProjectMeta,
    counts: TransferCounts,
}

/// 画布快照 —— 复用现有 row 结构,保证形状与 DB 读写单一口径。
#[derive(Debug, Serialize, Deserialize)]
struct CanvasBundle {
    cards: Vec<CardRow>,
    connections: Vec<ConnectionRow>,
    groups: Vec<CardGroupRow>,
}

// ── 导出 ────────────────────────────────────────────────────

#[tauri::command]
pub async fn export_project(
    state: State<'_, AppState>,
    project_id: String,
    dest_path: String,
) -> Result<TransferCounts, String> {
    // 1. 锁内只读快照(项目元数据 + 画布三表),随即出锁。
    let (meta, bundle, data_dir) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let meta = read_project_meta(&db, &project_id)?;
        let bundle = CanvasBundle {
            cards: query_cards(&db, &project_id).map_err(|e| e.to_string())?,
            connections: query_connections(&db, &project_id).map_err(|e| e.to_string())?,
            groups: query_groups(&db, &project_id).map_err(|e| e.to_string())?,
        };
        (meta, bundle, state.data_dir.clone())
    };

    // 2. 扫出被引用的本地媒体相对路径(远程 http 媒体不打包)。
    let mut media_paths: BTreeSet<String> = BTreeSet::new();
    for card in &bundle.cards {
        collect_media_paths(&card.data, &mut media_paths);
    }
    if let Some(thumb) = &meta.thumbnail {
        collect_media_paths(thumb, &mut media_paths);
    }

    // 3. 打包(blocking):流式写 zip,不持任何锁。
    let app_version = env!("CARGO_PKG_VERSION").to_string();
    run_blocking(move || {
        write_archive(
            Path::new(&dest_path),
            &meta,
            &bundle,
            &media_paths,
            &data_dir,
            &app_version,
        )
    })
    .await
}

fn read_project_meta(conn: &rusqlite::Connection, project_id: &str) -> Result<ProjectMeta, String> {
    conn.query_row(
        "SELECT title, thumbnail FROM projects WHERE id = ?1",
        rusqlite::params![project_id],
        |row| {
            Ok(ProjectMeta {
                title: row.get(0)?,
                thumbnail: row.get(1)?,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => "项目不存在或已删除".to_string(),
        other => other.to_string(),
    })
}

fn write_archive(
    dest_path: &Path,
    meta: &ProjectMeta,
    bundle: &CanvasBundle,
    media_paths: &BTreeSet<String>,
    data_dir: &Path,
    app_version: &str,
) -> Result<TransferCounts, String> {
    let file = std::fs::File::create(dest_path).map_err(|e| format!("创建导出文件失败: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    // 媒体本就是压缩格式、canvas.json 体量小,统一 Stored 不浪费 CPU。
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

    let mut counts = TransferCounts {
        cards: bundle.cards.len(),
        connections: bundle.connections.len(),
        groups: bundle.groups.len(),
        media: 0,
        media_missing: 0,
    };

    // 媒体先写,顺带统计命中 / 缺失。
    for rel in media_paths {
        let abs = data_dir.join(rel);
        match std::fs::File::open(&abs) {
            Ok(mut src) => {
                zip.start_file(rel.as_str(), opts)
                    .map_err(|e| format!("写入媒体条目失败: {e}"))?;
                std::io::copy(&mut src, &mut zip)
                    .map_err(|e| format!("拷贝媒体 {rel} 失败: {e}"))?;
                counts.media += 1;
            }
            Err(_) => {
                tracing::warn!("[export] 媒体文件缺失,跳过: {:?}", abs);
                counts.media_missing += 1;
            }
        }
    }

    // manifest.json(此时 counts 的媒体数已确定)。
    let manifest = Manifest {
        format_version: FORMAT_VERSION,
        app_version: app_version.to_string(),
        exported_at: Local::now().to_rfc3339(),
        project: meta.clone(),
        counts: counts.clone(),
    };
    write_json_entry(&mut zip, MANIFEST_ENTRY, opts, &manifest)?;
    write_json_entry(&mut zip, CANVAS_ENTRY, opts, bundle)?;

    zip.finish().map_err(|e| format!("完成打包失败: {e}"))?;
    Ok(counts)
}

fn write_json_entry<T: Serialize>(
    zip: &mut zip::ZipWriter<std::fs::File>,
    entry_name: &str,
    opts: SimpleFileOptions,
    value: &T,
) -> Result<(), String> {
    let json = serde_json::to_vec(value).map_err(|e| format!("序列化 {entry_name} 失败: {e}"))?;
    zip.start_file(entry_name, opts)
        .map_err(|e| format!("写入 {entry_name} 失败: {e}"))?;
    zip.write_all(&json)
        .map_err(|e| format!("写入 {entry_name} 失败: {e}"))?;
    Ok(())
}

/// 从文本(`card.data` / `thumbnail`)里扫出本地媒体相对路径(形如 `media/images/xxx.jpg`)。
/// 媒体存储规约保证本地媒体一律是 `media/...` 相对路径(见 src/lib/media.ts URL 约定);
/// 远程 http(s) / data: / 绝对路径不在此列,不打包。
fn collect_media_paths(text: &str, out: &mut BTreeSet<String>) {
    let bytes = text.as_bytes();
    let mut from = 0;
    while let Some(off) = text[from..].find(MEDIA_PREFIX) {
        let start = from + off;
        // 左边界:NEEDLE 前一个字符若是路径字符,说明这是更长 token 的一部分
        // (例如 "/media/..." 是绝对路径、"xmedia/" 是别的词),跳过。
        if start > 0 && is_path_byte(bytes[start - 1]) {
            from = start + MEDIA_PREFIX.len();
            continue;
        }
        let mut end = start + MEDIA_PREFIX.len();
        while end < bytes.len() && is_path_byte(bytes[end]) {
            end += 1;
        }
        let path = &text[start..end];
        // 必须是文件(含扩展名、不以 / 结尾)才收。
        if path.len() > MEDIA_PREFIX.len() && path.contains('.') && !path.ends_with('/') {
            out.insert(path.to_string());
        }
        from = end.max(start + MEDIA_PREFIX.len());
    }
}

#[inline]
fn is_path_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'-' | b'_')
}

// ── 导入 ────────────────────────────────────────────────────

#[tauri::command]
pub async fn import_project(
    state: State<'_, AppState>,
    src_path: String,
) -> Result<ProjectInfo, String> {
    let data_dir = state.data_dir.clone();

    // 1. 解包(blocking):读 manifest + canvas,并把媒体解压回 data_dir/media。
    let (manifest, bundle) =
        run_blocking(move || read_archive(Path::new(&src_path), &data_dir)).await?;

    // 2. 版本校验 —— 比当前格式新就拒,给「说人话」的提示。
    if manifest.format_version > FORMAT_VERSION {
        return Err("该文件由更新版本的应用导出，请升级 AI 无限画布后再导入".to_string());
    }

    // 3. 入库(锁一次,事务内完成)。
    let info = {
        let mut db = state.db.lock().map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        let new_id = insert_imported_canvas(&tx, &manifest, &bundle)?;
        let info = query_project_info(&tx, &new_id).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        info
    };

    Ok(info)
}

fn read_archive(src_path: &Path, data_dir: &Path) -> Result<(Manifest, CanvasBundle), String> {
    let file = std::fs::File::open(src_path).map_err(|e| format!("打开文件失败: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|_| "这不是有效的 .aicat 项目文件".to_string())?;

    let manifest: Manifest = read_json_entry(&mut archive, MANIFEST_ENTRY, "项目清单")?;
    let bundle: CanvasBundle = read_json_entry(&mut archive, CANVAS_ENTRY, "画布数据")?;

    // 媒体解压回 data_dir/media(zip-slip 安全 + 内容寻址幂等)。
    let media_root = data_dir.join("media");
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取压缩条目失败: {e}"))?;
        if !entry.is_file() {
            continue;
        }
        let Some(dest) = safe_media_dest(&media_root, entry.name()) else {
            continue; // 非 media/ 条目(manifest/canvas)或可疑路径,跳过
        };
        if dest.exists() {
            continue; // 内容寻址:同名即同内容,无需覆盖
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建媒体目录失败: {e}"))?;
        }
        let mut out = std::fs::File::create(&dest).map_err(|e| format!("写入媒体文件失败: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("解压媒体失败: {e}"))?;
    }

    Ok((manifest, bundle))
}

fn read_json_entry<T: serde::de::DeserializeOwned>(
    archive: &mut zip::ZipArchive<std::fs::File>,
    entry_name: &str,
    human_name: &str,
) -> Result<T, String> {
    let mut entry = archive
        .by_name(entry_name)
        .map_err(|_| format!("文件已损坏：缺少{human_name}"))?;
    let mut buf = String::new();
    entry
        .read_to_string(&mut buf)
        .map_err(|e| format!("读取{human_name}失败: {e}"))?;
    serde_json::from_str(&buf).map_err(|e| format!("解析{human_name}失败: {e}"))
}

/// zip-slip 防御:只接受 `media/` 前缀、仅含「普通」路径分量的条目,
/// 并把它映射到 `media_root` 下的目标路径。其余(`..`、绝对路径、盘符)一律拒绝。
fn safe_media_dest(media_root: &Path, entry_name: &str) -> Option<PathBuf> {
    let rel = entry_name.strip_prefix(MEDIA_PREFIX)?;
    if rel.is_empty() {
        return None;
    }
    let rel_path = Path::new(rel);
    if rel_path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return None;
    }
    let dest = media_root.join(rel_path);
    // 双保险:规范化后仍必须落在 media_root 之内。
    if !dest.starts_with(media_root) {
        return None;
    }
    Some(dest)
}

/// 把画布快照插入为一个全新项目,返回新项目 id。
fn insert_imported_canvas(
    tx: &rusqlite::Connection,
    manifest: &Manifest,
    bundle: &CanvasBundle,
) -> Result<String, String> {
    let new_project_id = Uuid::new_v4().to_string();
    let title = format!("{}（导入）", manifest.project.title);

    tx.execute(
        "INSERT INTO projects (id, title, thumbnail) VALUES (?1, ?2, ?3)",
        rusqlite::params![new_project_id, title, manifest.project.thumbnail],
    )
    .map_err(|e| e.to_string())?;

    let id_map = build_card_id_map(&bundle.cards);

    // cards —— data 里内嵌的旧卡片 id 必须一并重映射(见模块顶部说明)。
    for card in &bundle.cards {
        let new_id = id_map
            .get(&card.id)
            .ok_or_else(|| format!("内部错误：卡片 {} 缺少 id 映射", card.id))?;
        let row = CardRow {
            id: new_id.clone(),
            project_id: new_project_id.clone(),
            data: remap_ids_in_text(&card.data, &id_map),
            ..card.clone()
        };
        upsert_card(tx, &row).map_err(|e| e.to_string())?;
    }

    // connections —— 两端都必须在映射里,否则是悬空连线,直接丢弃。
    for conn in &bundle.connections {
        let (Some(src), Some(dst)) = (
            id_map.get(&conn.source_card_id),
            id_map.get(&conn.target_card_id),
        ) else {
            continue;
        };
        tx.execute(
            "INSERT INTO connections (id, project_id, source_card_id, target_card_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                Uuid::new_v4().to_string(),
                new_project_id,
                src,
                dst,
                conn.created_at,
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    // groups —— card_ids 走映射并剔除未映射项。
    for group in &bundle.groups {
        let row = CardGroupRow {
            id: Uuid::new_v4().to_string(),
            project_id: new_project_id.clone(),
            card_ids: remap_group_card_ids(&group.card_ids, &id_map),
            ..group.clone()
        };
        upsert_group(tx, &row).map_err(|e| e.to_string())?;
    }

    Ok(new_project_id)
}

/// 为一批卡片生成 旧id→新id 映射。保证新 id 既不与任何旧 id 相同、也互不重复 ——
/// 这样后续对 `card.data` 做顺序无关的逐项文本替换是安全的(新插入的 id 不会被
/// 后续某个旧 id 再次命中)。
fn build_card_id_map(cards: &[CardRow]) -> HashMap<String, String> {
    let old_ids: HashSet<&str> = cards.iter().map(|c| c.id.as_str()).collect();
    let mut map: HashMap<String, String> = HashMap::with_capacity(cards.len());
    let mut used: HashSet<String> = HashSet::new();
    for card in cards {
        if map.contains_key(&card.id) {
            continue; // 防御:理论上 cards.id 唯一
        }
        let mut new_id = Uuid::new_v4().to_string();
        while old_ids.contains(new_id.as_str()) || used.contains(&new_id) {
            new_id = Uuid::new_v4().to_string();
        }
        used.insert(new_id.clone());
        map.insert(card.id.clone(), new_id);
    }
    map
}

/// 把文本里出现的旧卡片 id 全部替换成新 id。只替换 `id_map` 的 key(卡片 id),
/// 不碰媒体文件名里的 uuid —— 那些不在 map 里,且媒体导入时按原名落盘。
fn remap_ids_in_text(text: &str, id_map: &HashMap<String, String>) -> String {
    let mut out = text.to_string();
    for (old, new) in id_map {
        if out.contains(old.as_str()) {
            out = out.replace(old.as_str(), new);
        }
    }
    out
}

/// `card_ids` 是 JSON 字符串数组,逐个映射,丢弃未映射(指向已不在副本里的卡)的项。
/// 解析失败兜底为空数组,前端 `sanitizeGroupsAgainstCards` 会再做一次一致性收口。
fn remap_group_card_ids(card_ids_json: &str, id_map: &HashMap<String, String>) -> String {
    let Ok(ids) = serde_json::from_str::<Vec<String>>(card_ids_json) else {
        return "[]".to_string();
    };
    let mapped: Vec<&String> = ids.iter().filter_map(|id| id_map.get(id)).collect();
    serde_json::to_string(&mapped).unwrap_or_else(|_| "[]".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_media_paths_picks_local_skips_remote() {
        let mut out = BTreeSet::new();
        let text = r#"{"imageUrl":"media/images/abc.png","remote":"https://x/media/y.png","thumb":"/media/z.png"}"#;
        collect_media_paths(text, &mut out);
        assert!(out.contains("media/images/abc.png"));
        // 远程 URL 里的 media/ 前面是 '/',绝对路径里的 media/ 前面也是 '/' → 都不收
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn safe_media_dest_blocks_zip_slip() {
        let root = Path::new("/data/media");
        assert!(safe_media_dest(root, "media/images/a.png").is_some());
        assert!(safe_media_dest(root, "media/../../etc/passwd").is_none());
        assert!(safe_media_dest(root, "canvas.json").is_none());
        assert!(safe_media_dest(root, "media/").is_none());
    }

    #[test]
    fn remap_ids_rewrites_embedded_card_ids() {
        let mut id_map = HashMap::new();
        id_map.insert("old-1".to_string(), "new-1".to_string());
        id_map.insert("old-2".to_string(), "new-2".to_string());
        // upstreamTexts 的 key 是卡片 id —— 文本替换能覆盖到
        let data = r#"{"upstreamCardId":"old-1","upstreamTexts":{"old-2":"hi"}}"#;
        let out = remap_ids_in_text(data, &id_map);
        assert!(out.contains("new-1"));
        assert!(out.contains("new-2"));
        assert!(!out.contains("old-1"));
        assert!(!out.contains("old-2"));
    }

    #[test]
    fn remap_group_card_ids_drops_unmapped() {
        let mut id_map = HashMap::new();
        id_map.insert("a".to_string(), "A".to_string());
        let out = remap_group_card_ids(r#"["a","ghost"]"#, &id_map);
        assert_eq!(out, r#"["A"]"#);
    }

    fn migrated_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    fn sample_card(id: &str, data: &str, z: i64) -> CardRow {
        CardRow {
            id: id.into(),
            project_id: "p1".into(),
            card_type: "ai_image".into(),
            x: 0.0,
            y: 0.0,
            width: 320.0,
            height: 240.0,
            z_index: z,
            locked: false,
            collapsed: false,
            color: None,
            title: None,
            data: data.into(),
            created_at: "2024-01-01 00:00:00".into(),
            updated_at: "2024-01-01 00:00:00".into(),
        }
    }

    /// 全链路:建项目(卡 + 连线 + 分组 + 本地媒体)→ 打包 → 解包到全新 data_dir
    /// → 入库为新项目。验证三件最关键的事:① `card.data` 内嵌的旧卡片 id 被改写成
    /// 新 id(否则加载时会被悬空清理抹掉);② 连线端点 / 分组 card_ids 同步重映射;
    /// ③ 媒体被真实解压到新 data_dir。
    #[test]
    fn export_import_round_trip_rewrites_ids_and_carries_media() {
        use std::io::Write as _;

        let conn = migrated_conn();
        conn.execute("INSERT INTO projects (id, title) VALUES ('p1', '测试')", [])
            .unwrap();

        let media_rel = "media/images/MEDIA0001.png";
        // A 引用媒体;B 通过 upstreamCardId + upstreamTexts 的 key 内嵌指向 A 的 id。
        upsert_card(&conn, &sample_card("card-a", &format!(r#"{{"imageUrl":"{media_rel}"}}"#), 0))
            .unwrap();
        upsert_card(
            &conn,
            &sample_card(
                "card-b",
                r#"{"upstreamCardId":"card-a","upstreamTexts":{"card-a":"hi"}}"#,
                1,
            ),
        )
        .unwrap();
        conn.execute(
            "INSERT INTO connections (id, project_id, source_card_id, target_card_id, created_at)
             VALUES ('c1', 'p1', 'card-a', 'card-b', '2024-01-01 00:00:00')",
            [],
        )
        .unwrap();
        upsert_group(
            &conn,
            &CardGroupRow {
                id: "g1".into(),
                project_id: "p1".into(),
                card_ids: r#"["card-a","card-b"]"#.into(),
                title: "组".into(),
                color: "#7C3AED".into(),
                collapsed: false,
                created_at: "2024-01-01 00:00:00".into(),
                updated_at: "2024-01-01 00:00:00".into(),
            },
        )
        .unwrap();

        // 源 data_dir + 媒体文件。
        let src_dir = tempfile::tempdir().unwrap();
        let media_abs = src_dir.path().join(media_rel);
        std::fs::create_dir_all(media_abs.parent().unwrap()).unwrap();
        std::fs::File::create(&media_abs)
            .unwrap()
            .write_all(b"PNGDATA")
            .unwrap();

        // 导出。
        let meta = read_project_meta(&conn, "p1").unwrap();
        let bundle = CanvasBundle {
            cards: query_cards(&conn, "p1").unwrap(),
            connections: query_connections(&conn, "p1").unwrap(),
            groups: query_groups(&conn, "p1").unwrap(),
        };
        let mut media_paths = BTreeSet::new();
        for c in &bundle.cards {
            collect_media_paths(&c.data, &mut media_paths);
        }
        let archive = src_dir.path().join("out.aicat");
        let counts =
            write_archive(&archive, &meta, &bundle, &media_paths, src_dir.path(), "test").unwrap();
        assert_eq!((counts.cards, counts.media, counts.media_missing), (2, 1, 0));

        // 导入到全新 data_dir,入库为新项目。
        let dst_dir = tempfile::tempdir().unwrap();
        let (manifest, read_bundle) = read_archive(&archive, dst_dir.path()).unwrap();
        assert!(
            dst_dir.path().join(media_rel).exists(),
            "媒体应被解压到新 data_dir"
        );
        let new_pid = insert_imported_canvas(&conn, &manifest, &read_bundle).unwrap();

        let new_cards = query_cards(&conn, &new_pid).unwrap();
        assert_eq!(new_cards.len(), 2);
        let new_a = new_cards
            .iter()
            .find(|c| c.data.contains(media_rel))
            .expect("A 的副本");
        let new_b = new_cards
            .iter()
            .find(|c| c.data.contains("upstreamCardId"))
            .expect("B 的副本");
        assert!(!new_b.data.contains("card-a"), "B 的 data 不应再含旧 id");
        assert!(
            new_b.data.contains(new_a.id.as_str()),
            "B 的 upstreamCardId 应指向 A 的新 id"
        );

        let new_conns = query_connections(&conn, &new_pid).unwrap();
        assert_eq!(new_conns.len(), 1);
        assert_eq!(new_conns[0].source_card_id, new_a.id);
        assert_eq!(new_conns[0].target_card_id, new_b.id);

        let new_groups = query_groups(&conn, &new_pid).unwrap();
        assert_eq!(new_groups.len(), 1);
        let gids: Vec<String> = serde_json::from_str(&new_groups[0].card_ids).unwrap();
        assert!(gids.contains(&new_a.id) && gids.contains(&new_b.id));
        assert!(!new_groups[0].card_ids.contains("card-a"));
    }
}
