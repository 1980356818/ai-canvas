use rusqlite::Connection;

const CURRENT_VERSION: u32 = 13;

pub fn run(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    let version: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    tracing::info!("database version: {}, target: {}", version, CURRENT_VERSION);

    if version < 1 {
        migrate_v1(conn)?;
    }
    if version < 2 {
        migrate_v2(conn)?;
    }
    if version < 3 {
        migrate_v3(conn)?;
    }
    if version < 4 {
        migrate_v4(conn)?;
    }
    if version < 5 {
        migrate_v5(conn)?;
    }
    if version < 6 {
        migrate_v6(conn)?;
    }
    if version < 7 {
        migrate_v7(conn)?;
    }
    if version < 8 {
        migrate_v8(conn)?;
    }
    if version < 9 {
        migrate_v9(conn)?;
    }
    if version < 10 {
        migrate_v10(conn)?;
    }
    // 注:本仓没有 v11 —— bounds 迁移用 v12(原因见 migrate_v12 注释)。
    if version < 12 {
        migrate_v12(conn)?;
    }
    if version < 13 {
        migrate_v13(conn)?;
    }

    Ok(())
}

fn migrate_v1(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("running migration v1: initial schema");

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS projects (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL DEFAULT 'Untitled',
            thumbnail   TEXT,
            node_count  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS cards (
            id          TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            type        TEXT NOT NULL,
            x           REAL NOT NULL DEFAULT 0,
            y           REAL NOT NULL DEFAULT 0,
            width       REAL NOT NULL DEFAULT 320,
            height      REAL NOT NULL DEFAULT 240,
            z_index     INTEGER NOT NULL DEFAULT 0,
            locked      INTEGER NOT NULL DEFAULT 0,
            collapsed   INTEGER NOT NULL DEFAULT 0,
            color       TEXT,
            title       TEXT,
            data        TEXT NOT NULL DEFAULT '{}',
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_cards_project ON cards(project_id);

        CREATE TABLE IF NOT EXISTS settings (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL
        );

        PRAGMA user_version = 1;
        ",
    )?;

    Ok(())
}

fn migrate_v2(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("running migration v2: agent sessions");

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS agent_sessions (
            id          TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            messages    TEXT NOT NULL DEFAULT '[]',
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_project ON agent_sessions(project_id);

        PRAGMA user_version = 2;
        ",
    )?;

    Ok(())
}

fn migrate_v3(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("running migration v3: soft delete for projects");

    conn.execute_batch(
        "
        ALTER TABLE projects ADD COLUMN deleted_at TEXT;

        PRAGMA user_version = 3;
        ",
    )?;

    Ok(())
}

fn migrate_v4(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("running migration v4: seed default API base URL");

    conn.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
        rusqlite::params!["openai_base_url", "https://ai.comfly.org"],
    )?;

    conn.execute_batch("PRAGMA user_version = 4;")?;
    Ok(())
}

fn migrate_v5(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("running migration v5: connections table");

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS connections (
            id              TEXT PRIMARY KEY,
            project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            source_card_id  TEXT NOT NULL,
            target_card_id  TEXT NOT NULL,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(project_id, source_card_id, target_card_id)
        );
        CREATE INDEX IF NOT EXISTS idx_connections_project ON connections(project_id);
        CREATE INDEX IF NOT EXISTS idx_connections_source ON connections(source_card_id);
        CREATE INDEX IF NOT EXISTS idx_connections_target ON connections(target_card_id);

        PRAGMA user_version = 5;
        ",
    )?;

    Ok(())
}

fn migrate_v6(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("running migration v6: chat sessions & messages");

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS chat_sessions (
            id          TEXT PRIMARY KEY,
            project_id  TEXT,
            title       TEXT NOT NULL DEFAULT 'New Chat',
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS chat_messages (
            id          TEXT PRIMARY KEY,
            session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
            role        TEXT NOT NULL,
            content     TEXT NOT NULL DEFAULT '[]',
            metadata    TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);

        PRAGMA user_version = 6;
        ",
    )?;

    Ok(())
}

fn migrate_v7(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("running migration v7: unified async tasks");

    // tasks 表是异步任务的"权威记录"：UI 通过它判断卡片是否在跑、是否失败、
    // 能不能恢复。每个 card 可能有多个历史 task（重试/恢复会留痕），UI 看
    // 最近一条 active 即可。
    //
    // status 枚举（与前端 TaskStatus 一一对应）:
    //   queued     —— 已创建本地记录，尚未发起 submit
    //   submitting —— submit 请求在途
    //   polling    —— 已拿到 external_task_id，轮询中
    //   success    —— 终态，结果落 result_payload
    //   failed     —— 终态，error_kind/error_message 写明原因
    //   canceled   —— 终态，用户主动取消
    //   orphaned   —— 重试/项目恢复时把旧的活动任务标记为孤儿，便于追溯
    //
    // error_kind 枚举（前端 TaskError 的 discriminator）:
    //   network | timeout | server_5xx       —— transient（不打死卡片）
    //   client_4xx | business_failed | parse —— permanent
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS tasks (
            id                  TEXT PRIMARY KEY,
            card_id             TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
            project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            provider            TEXT NOT NULL,
            kind                TEXT NOT NULL,
            submit_endpoint     TEXT NOT NULL,
            poll_endpoint       TEXT,
            external_task_id    TEXT,
            status              TEXT NOT NULL DEFAULT 'queued',
            progress            REAL NOT NULL DEFAULT 0,
            request_payload     TEXT NOT NULL DEFAULT '{}',
            result_payload      TEXT,
            error_kind          TEXT,
            error_message       TEXT,
            key_tag             TEXT,
            retry_count         INTEGER NOT NULL DEFAULT 0,
            created_at          TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
            last_polled_at      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_card ON tasks(card_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

        PRAGMA user_version = 7;
        ",
    )?;

    Ok(())
}

fn migrate_v8(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("running migration v8: remote upload cache");

    // uploaded_files —— ai-canvas 已上传到 JiJing server 的文件本地索引,
    // 让"二次使用同一张图"直接命中已有 URL 不重传。详见
    // docs/media-upload-refactor.md §3.4 与 commands/upload_remote.rs。
    //
    // 复合主键 (sha256, server_origin) 而非自增 id —— 同一台机器上同一文件
    // 上传到不同 server (用户切了 provider) 是两条独立记录;同一 server 多次
    // 调用同一文件应天然命中。
    //
    // local_path_hint 不参与主键, 仅作"反向查找"提示 (本地路径换了/被删了
    // 不影响缓存命中, 因为命中是按 sha256)。
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS uploaded_files (
            sha256          TEXT NOT NULL,
            server_origin   TEXT NOT NULL,
            remote_url      TEXT NOT NULL,
            content_type    TEXT NOT NULL,
            size_bytes      INTEGER NOT NULL,
            local_path_hint TEXT,
            uploaded_at     INTEGER NOT NULL,
            last_used_at    INTEGER NOT NULL,
            PRIMARY KEY (sha256, server_origin)
        );
        CREATE INDEX IF NOT EXISTS idx_uploaded_files_lru
            ON uploaded_files(last_used_at);
        CREATE INDEX IF NOT EXISTS idx_uploaded_files_path_hint
            ON uploaded_files(local_path_hint);

        PRAGMA user_version = 8;
        ",
    )?;

    Ok(())
}

fn migrate_v9(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("running migration v9: card groups");

    // card_groups —— 节点分组(把多张卡圈成可一键运行的子单元)。
    //
    // card_ids 是 JSON 数组字符串(["uuid1","uuid2",...])。
    // 一卡只能属一组 —— 不在 DB 层强制(SQLite 没法对 JSON 数组里的值建唯一约束),
    // 由前端 groupStore + groupConsistency 维护这个不变式。
    //
    // 子卡被删时:
    //   • cards.id 软引用 —— 我们不在 card_ids 上加 FK(JSON 内列不能),
    //     而是由前端"删卡 lifecycle hook"调 groupConsistency.removeCardsFromGroups
    //     同步移除;空组自动删。
    //   • 整个 project 删时:走 ON DELETE CASCADE 一并清掉。
    //
    // 几何信息(bounds)**不存储** —— 实时按 cardIds + cards.x/y/w/h 计算,
    // 持久化派生数据等于自找麻烦(数据漂移 / 历史脏数据等)。
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS card_groups (
            id          TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            card_ids    TEXT NOT NULL DEFAULT '[]',
            title       TEXT NOT NULL DEFAULT '',
            color       TEXT NOT NULL DEFAULT '#7C3AED',
            collapsed   INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_card_groups_project ON card_groups(project_id);

        PRAGMA user_version = 9;
        ",
    )?;

    Ok(())
}

fn migrate_v10(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("running migration v10: comfly domain move (ai.comfly.chat -> ai.comfly.org)");

    // Comfly 域名搬家 (.chat → .org)。v4 早给老用户 sqlite 种过
    // openai_base_url = "https://ai.comfly.chat"; 那条迁移已 run 过不会重跑,
    // 所以这里把「仍是旧默认值」的行就地改成新域名, 否则老安装会一直打死域名。
    // 只动等于旧默认的行 —— 用户在设置里自定义过的 base_url 一律不碰。
    conn.execute(
        "UPDATE settings SET value = ?1 \
         WHERE key IN ('openai_base_url', 'comfly_base_url') AND value = ?2",
        rusqlite::params!["https://ai.comfly.org", "https://ai.comfly.chat"],
    )?;

    conn.execute_batch("PRAGMA user_version = 10;")?;
    Ok(())
}

fn migrate_v12(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("running migration v12: card group stored frame bounds");

    // ⚠ 用 v12(跳过 v11):部分历史/开发库已被一条早先(已移除)的迁移占用到 user_version=11,
    //   而那条 v11 并不含 bounds 列。若把本迁移设为 v11,这些库会因 version 已=11 而跳过它,
    //   导致 groups.rs 引用的 x/y/width/height 列缺失而报错。设为 v12 保证在 v10/v11 库上都会执行。
    //   (与 lumaxflow 的 v12=bounds 编号也对齐。)
    //
    // Frame 容器化:组从「card_ids 清单 + 成员外接框」升级为拥有自己存储边界的容器。
    // 成员 = 落在边界矩形内的卡片(空间即真相),由前端「成员校准权威」在每次几何提交时
    // 从边界重算 card_ids(card_ids 列保留为派生缓存)。
    //
    // 新增 4 列存边界;width=0 作「未回填」哨兵 —— 老行 / 旧导入在「打开项目」时由前端
    // 用当前成员外接框回填(见 hooks/useProjectLifecycle.ts),保证老项目视觉零变化。
    // 详见 docs/Frame容器化-架构与施工图.md。
    conn.execute_batch(
        "
        ALTER TABLE card_groups ADD COLUMN x      REAL NOT NULL DEFAULT 0;
        ALTER TABLE card_groups ADD COLUMN y      REAL NOT NULL DEFAULT 0;
        ALTER TABLE card_groups ADD COLUMN width  REAL NOT NULL DEFAULT 0;
        ALTER TABLE card_groups ADD COLUMN height REAL NOT NULL DEFAULT 0;

        PRAGMA user_version = 12;
        ",
    )?;

    Ok(())
}

fn migrate_v13(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("running migration v13: task generation attempts (keep-alive + per-card panel)");

    // 「卡片任务面板」:让一张卡的每一次生成尝试(含被「重新生成」替换掉的)都可观测、可存图。
    //
    //   attempt_no    —— 该卡内尝试序号(1,2,3…),用于面板展示「尝试 #N」与排序。
    //   superseded_at —— 单轴「被替换」标记。NULL = 当前尝试(**唯一**驱动画布卡的进度/错误/结果);
    //                    非空 = 被后来的「重新生成」替换。已计费的被替换任务会保活后台跑完、
    //                    结果只进任务面板不写画布(根治「旧任务晚完成盖掉新卡」竞态)。
    //
    // 不加 cost 列 —— App 端不参与计费、本地无价格源,产品上也不展示费用数字。
    conn.execute_batch(
        "
        ALTER TABLE tasks ADD COLUMN attempt_no    INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE tasks ADD COLUMN superseded_at TEXT;

        CREATE INDEX IF NOT EXISTS idx_tasks_card_superseded
            ON tasks(card_id, superseded_at);
        ",
    )?;

    // 回填 attempt_no:按 card 内 created_at 升序编号(相关子查询,无窗口函数,移植性好)。
    conn.execute_batch(
        "
        UPDATE tasks SET attempt_no = 1 + (
            SELECT COUNT(*) FROM tasks t2
            WHERE t2.card_id = tasks.card_id
              AND (t2.created_at <  tasks.created_at
                OR (t2.created_at = tasks.created_at AND t2.id < tasks.id))
        );
        ",
    )?;

    // 回填 superseded_at:每张卡只保留「最新一条」为当前,其余标记被替换。
    // 既消化历史 orphaned 行,又保证「每卡至多一个当前尝试」的不变量在迁移后即成立。
    conn.execute_batch(
        "
        UPDATE tasks SET superseded_at = updated_at
        WHERE superseded_at IS NULL
          AND EXISTS (
            SELECT 1 FROM tasks t2
            WHERE t2.card_id = tasks.card_id
              AND (t2.created_at >  tasks.created_at
                OR (t2.created_at = tasks.created_at AND t2.id > tasks.id))
          );
        ",
    )?;

    conn.execute_batch("PRAGMA user_version = 13;")?;
    Ok(())
}
