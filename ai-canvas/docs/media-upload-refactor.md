# ai-canvas 媒体传输架构重构计划

> 状态：Draft
> 日期：2026-05-25
> 关联文档：`JiJing_Server/docs/arch/base64-image-upload-refactor.md`（服务端规划，2026-04-20）
> 触发事件：用户挂 6 张图调生图模型，Rust 端 `ipc_guard::check_inline_total_bytes` 报 "请求体引用的本地文件累计超过 64MB 上限"

---

## 0. TL;DR

把所有送往上游 AI API 的本地图/视频/音频从 base64 inline 改成 HTTP URL 引用，**统一入口**为 `mediaToApiRef(localPath) → httpUrl`，所有调用点（chat / 生图 / 生视频 / 各 Editor）全部走它，不再有第二条路径。

服务端的 `Base64ImageSanitizer` 已落地，但 ai-canvas 客户端始终没接上。本计划补齐客户端缺口，并彻底删除两条历史路径（`getBase64ForApi` + Rust `inline_local_files` 的 base64 展开）。

---

## 1. 现状与问题根因

### 1.1 撞过的墙

按请求出 ai-canvas 的方向排序：

| 关卡 | 上限 | 位置 | 触发后症状 |
|---|---|---|---|
| Tauri IPC 单次字符串 | ~3 MB | WebView2 原生限制 | `ERR_CONNECTION_REFUSED` / WebView2 闪退 |
| Rust `inline_local_files` 累计 | 64 MB (base64) | `src-tauri/src/commands/ipc_limits.rs:65` | 报错 "请求体引用的本地文件累计超过 64MB 上限" |
| nginx `client_max_body_size` | 100 MB | `ai.snoworangekeji.cn_nginx:162` | HTTP 413 |
| Spring `max-request-size` | 100 MB | `application.yml:34` | 413 |
| MySQL `request_params` | 隐性 | `media_task` 表 | `Out of sort memory`（2026-04 P0） |
| 上游 provider body | provider-specific | 各家不同 | 503 / token 上限报错 |

调高任何一道都是把雷区往后推。根因是**架构错误：二进制不该走 JSON**。所有主流 AI provider 的 vision 接口都支持 HTTP URL。

### 1.2 ai-canvas 客户端的多个隐患

逐项独立分析过后总结：

1. **`getBase64ForApi` 语义混乱**（[`media.ts:465`](../src/lib/media.ts)）
   - Tauri 模式返回 `local://` 占位符
   - Web 模式返回 `data:...base64` URL
   - 调用方猜不准结果是哪种，下游处理混乱

2. **`compressDataUrlForApi` 在桌面端从来没生效**（[`base.ts:238/276`](../src/providers/openai-compat/base.ts)）
   - 第一行 `if (!dataUrl.startsWith("data:")) return dataUrl;`
   - Tauri 模式传入永远是 `local://`，等于空跑
   - 注释里写的"在送往 API 前对参考图统一做'过大才压缩'"实际是死代码（Web 模式才生效，但桌面端是主战场）

3. **Chat / 视频 / 媒体编辑各自重复**
   - `ChatEditor.tsx` 4 处直接调 `getBase64ForApi`
   - `chatStore.ts`、`promptSerializer.ts`、`MultiangleEditor.tsx`、`MediaEditor.tsx`、`VideoEditor.tsx` 各自又调一遍
   - 任何一个调用点漏了压缩 / 漏了 URL 化，整条链路就退化

4. **Rust `inline_local_files` 把 6 个调用点的锅都自己背了**（[`ai.rs:111`](../src-tauri/src/commands/ai.rs)）
   - 不管哪个 ts 调用点送上来的 `local://`，Rust 都读盘 + base64
   - 没人记得调压缩，所以最后撞 64MB 累计上限

5. **服务端的 `Base64ImageSanitizer` 兜底也救不了**
   - sanitizer 在 nginx 之后、TaskService 之前拦
   - 但请求在出 ai-canvas 阶段就被 Rust ipc_guard 挡了，根本没到 nginx

### 1.3 服务端已经就绪（核对结果）

| 项 | 状态 | 位置 |
|---|---|---|
| `Base64ImageSanitizer` | ✅ | [`Base64ImageSanitizer.java`](../../JiJing/JiJing_Server/jijing-common/jijing-common-storage/src/main/java/com/jijing/common/storage/Base64ImageSanitizer.java) |
| `/v1/images/generations` 注入 sanitizer | ✅ | `MediaGenerationController.java:43` |
| `FileStorageService`（local / minio 双实现）| ✅ | `StorageAutoConfiguration.java` |
| 上传端点（consumer 路径） | ✅ 但路径不规范 | `ConsumerGenerateController.java:50` (`/consumer/generate/upload`) |
| **`/v1/files/upload` OpenAI 风格端点** | ❌ **缺** | 文档规划过，未实现 |
| 视频生成接 sanitizer | ✅ | `/v1/videos/generations` |
| 音频克隆接 sanitizer | ✅ | `/v1/audio/clone` |

---

## 2. 设计原则

按重要性排序：

1. **二进制永远不进 JSON**。所有送上游的 body 只含 URL/文本/小常量，单次 JSON 体积 ≤ 100 KB
2. **统一入口**。客户端只有一个函数 `mediaToApiRef`，所有调用点走它；Rust 只有一个 command `upload_to_server`
3. **语义单一**。`mediaToApiRef` 永远返 HTTP URL；不再有"可能 base64 可能占位符"的歧义
4. **服务端规范**。`/v1/files/upload` 走 OpenAI Files API 风格，路径在 `/v1/` 下而非业务模块下
5. **去重必须**。客户端按 sha256 缓存；服务端按 (userId, sha256) 去重；两端独立去重互不依赖
6. **彻底删除老路**。过渡期 + 监控 + 灰度 + 删除，不留半死代码
7. **失败语义清晰**。每种错误（413/401/网络/上游）都有明确 UI 提示，不掩盖
8. **可观测**。客户端 + 服务端打齐 metrics，知道每张图什么时候上传、命中率多少、失败率多少

---

## 3. 关键抉择（已拍板）

### 3.1 上传端点：新增 `/v1/files/upload`

**选项**：
- A. 复用 `/consumer/generate/upload`
- B. 新加 `/v1/files/upload`（OpenAI Files API 风格）
- C. 两者都有

**抉择：B**

理由：
- consumer 端点耦合"生图"业务语义，但上传图片不只服务生图（chat 视觉、视频参考、内联引用均会用）
- OpenAI `/v1/files` 是行业标准入口，文件管理与具体功能解耦
- ai-canvas 全程走 `/v1/*` 协议，文件上传也归到 `/v1/` 下统一
- JiJing 自己的 plan 文档就这样规划，遵从原 plan
- consumer 老端点保留（JiJing-Admin 等内部工具可能依赖），但 ai-canvas 不走它

### 3.2 鉴权：Bearer API Key

跟 `/v1/images/generations` 一致。`/v1/files/upload` 用同一套 `@RequireScope("file")` 注解 + API Key Bearer。

### 3.3 文件命名 & 路径：sha256 内容寻址

服务端落盘：
```
media/input/{userId}/{YYYYMMDD}/{sha256前16}.{ext}
```

天然去重 + URL 稳定可缓存 + 路径不暴露原文件名（隐私）。

### 3.4 客户端缓存：sqlite 表

Rust 端维护：
```sql
CREATE TABLE uploaded_files (
  local_path     TEXT NOT NULL,
  sha256         TEXT NOT NULL,
  server_origin  TEXT NOT NULL,  -- 服务端域名，切换 provider 需重传
  remote_url     TEXT NOT NULL,
  content_type   TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  uploaded_at    INTEGER NOT NULL,
  last_used_at   INTEGER NOT NULL,
  PRIMARY KEY (sha256, server_origin)
);
CREATE INDEX idx_uploaded_files_path ON uploaded_files(local_path);
CREATE INDEX idx_uploaded_files_lru ON uploaded_files(last_used_at);
```

策略：
- 优先按 `(sha256, server_origin)` 命中（同文件不重传）
- 退而按 `local_path` 反查 sha256（避免重新计算）
- 文件本地有改动（mtime/size 变了）→ 重算 sha256 → 必要时重传
- LRU 清理：> 30 天未使用 → 删本地记录（不删远端文件）
- 启动时清理"远端 URL 已 404"的脏记录

### 3.5 上传时机：生成时按需上传 + 后台预热

**主路径**：用户点"生成"时遍历未上传的引用 → `Promise.all` 限并发 4 上传 → 拿到 URL 拼 JSON → 发请求。
**辅路径（可选优化，phase 2）**：用户挂图时启动后台低优先级预热上传（成功了写缓存即可，失败静默不报错）。

理由：
- 主路径失败语义清晰（用户看到的就是"提交生成"延迟，重试在同一动作里完成）
- 后台预热让二次使用零延迟，但失败不打扰用户
- 不会浪费（用户改主意删图不会触发上传）

### 3.6 统一入口：`mediaToApiRef`

```typescript
/**
 * 把任何本地媒体引用（local:// / 相对存储路径 / data: URL / 前端 asset）
 * 转换成上游 API 可直接消费的 HTTP URL。
 *
 * 这是 ai-canvas 送出任何媒体的**唯一**入口。所有调用点（chat / 生图 /
 * 生视频 / 各 Editor）必须走这里，不允许私自构造 base64 或拼接 local://。
 *
 * 已 HTTP(S) URL：原样返回
 * Tauri 本地路径：invoke upload_to_server（命中缓存秒返）
 * Web dataURL：FormData POST /v1/files/upload
 * Vite 前端 asset：fetch → blob → 上传
 */
export async function mediaToApiRef(localPath: string): Promise<string>;
```

**关键约束**：
- `getBase64ForApi` 立刻标 `@deprecated`，内部改成"调 mediaToApiRef + warn once"
- `compressDataUrlForApi` 保留（上传前先压一道，减小服务端压力）但调用点收敛到 `mediaToApiRef` 内部
- 任何新代码不允许直接调 `getBase64ForApi`，eslint 规则拦截

### 3.7 老路径处理：保留兜底 + 监控 + 限期删除

- **Phase 1**：`mediaToApiRef` 上线，所有调用点切过去
- **Phase 2**：`getBase64ForApi` 内部改为转调 `mediaToApiRef` + `console.warn` 一次
- **Phase 3**：Rust `inline_local_files` 保留兜底（兼容老版本 ai-canvas 客户端），但加 `tracing::warn!("[ai_proxy] legacy local:// fallback used")`，监控 fallback 计数
- **Phase 4**（3 个月后，监控归零）：删 `inline_local_files`、删 `INLINE_LOCAL_FILES_TOTAL_HARD_LIMIT_BYTES`、删 `getBase64ForApi`、删 `compressDataUrlForApi` 中 Tauri 分支死代码

### 3.8 视频/音频统一通道

- 服务端 `Base64ImageSanitizer.MEDIA_KEYS = {"images", "image", "audio", "file"}` 已经支持
- `FileStorageService.store` 不挑 MIME
- ai-canvas 客户端 `mediaToApiRef` 不区分类型

**视频大文件（>50MB）**：phase 1 走"前端读全文件 → 单 multipart 上传"，nginx 上限 100MB 内够用。phase 2 改成分块上传（复用现有 `upload_media_chunk` 那套，但目的地从 Rust temp 改成服务端 chunk endpoint）。

### 3.9 Web 模式

`mediaToApiRef` 内部按 `isTauri` 分支：
- Tauri：`invoke("upload_to_server", { path })`
- Web：`fetch` + `FormData`
- 接口契约完全一致，调用方无感知

### 3.10 错误处理 & UX

| 错误 | UI 反应 | 重试策略 |
|---|---|---|
| 401 / 403 | "登录已过期，请重新登录" | 不自动重试 |
| 413（图太大）| 自动客户端压缩（`compressDataUrlForApi`）后重试一次 | 一次 |
| 5xx | "服务端临时故障，正在重试..." | 3 次 expon backoff |
| 网络中断 | "网络异常，请检查连接" | 3 次 |
| 415（MIME 不支持） | "不支持的文件格式" | 不重试 |
| 上传中 | 进度条 "正在上传 3/6..." | 通过 onProgress 透传 |

---

## 4. 服务端改造（jijing-gateway）

### 4.1 新增 `MediaUploadController`

文件：`jijing-gateway/src/main/java/com/jijing/gateway/controller/MediaUploadController.java`

```java
@Slf4j
@Tag(name = "媒体文件上传")
@RestController
@RequestMapping("/v1/files")
@RequiredArgsConstructor
public class MediaUploadController {

    private final FileStorageService fileStorageService;
    private final UploadedFileMapper uploadedFileMapper;  // 新增 mapper

    @Operation(summary = "上传媒体文件")
    @RequireScope("file")
    @PostMapping(value = "/upload", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public R<FileUploadResponse> upload(
            @CurrentUser Long userId,
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "purpose", defaultValue = "media-input") String purpose,
            @RequestParam(value = "sha256", required = false) String clientSha256) {

        // 1. MIME 白名单
        String contentType = file.getContentType();
        if (!ALLOWED_MIMES.contains(contentType)) {
            throw new BizException(ErrorCode.PARAM_INVALID, "不支持的文件类型: " + contentType);
        }

        // 2. 体积限制
        if (file.getSize() > MAX_UPLOAD_BYTES) {
            throw new BizException(ErrorCode.FILE_TOO_LARGE, ...);
        }

        // 3. 计算 sha256（流式）
        String sha256 = computeSha256(file);
        if (clientSha256 != null && !clientSha256.equals(sha256)) {
            throw new BizException(ErrorCode.PARAM_INVALID, "sha256 mismatch");
        }

        // 4. 去重命中
        UploadedFile existing = uploadedFileMapper.selectByUserAndSha(userId, sha256);
        if (existing != null) {
            return R.ok(FileUploadResponse.cached(existing));
        }

        // 5. 落盘
        String dateDir = LocalDate.now().format(DateTimeFormatter.ofPattern("yyyyMMdd"));
        String filename = sha256.substring(0, 16) + extensionFor(contentType);
        String directory = "media/input/" + userId + "/" + dateDir;
        StorageResult result = fileStorageService.store(file, directory, filename);

        // 6. 写入 DB 索引
        UploadedFile record = UploadedFile.builder()
                .userId(userId)
                .sha256(sha256)
                .url(result.getUrl())
                .contentType(contentType)
                .sizeBytes(file.getSize())
                .purpose(purpose)
                .createTime(LocalDateTime.now())
                .build();
        uploadedFileMapper.insert(record);

        return R.ok(FileUploadResponse.fresh(record));
    }

    private static final Set<String> ALLOWED_MIMES = Set.of(
            "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic",
            "video/mp4", "video/webm", "video/quicktime",
            "audio/mpeg", "audio/wav", "audio/ogg"
    );
    private static final long MAX_UPLOAD_BYTES = 100L * 1024 * 1024;  // 100MB，对齐 nginx
}
```

### 4.2 新增 DB 表 `uploaded_files`

```sql
CREATE TABLE uploaded_files (
    id            BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id       BIGINT NOT NULL,
    sha256        VARCHAR(64) NOT NULL,
    url           VARCHAR(512) NOT NULL,
    content_type  VARCHAR(64) NOT NULL,
    size_bytes    BIGINT NOT NULL,
    purpose       VARCHAR(32) NOT NULL DEFAULT 'media-input',
    create_time   DATETIME NOT NULL,
    last_used_at  DATETIME NOT NULL,
    deleted       TINYINT NOT NULL DEFAULT 0,
    UNIQUE KEY uk_user_sha (user_id, sha256),
    INDEX idx_lru (last_used_at)
) COMMENT '/v1/files/upload 上传索引，支持 sha256 去重';
```

### 4.3 速率限制

nginx 层加 `limit_req zone=files_upload_ip burst=20 nodelay`，每 IP 每秒不超过 10 次上传。配置写到 `ai.snoworangekeji.cn_nginx`。

### 4.4 nginx 路径放行

```nginx
location ^~ /api/v1/files/ {
    limit_req zone=files_upload_ip burst=20 nodelay;
    client_max_body_size 100m;  # 显式覆盖，跟 server 块对齐
    rewrite ^/api(/.*)$ $1 break;
    proxy_pass http://jijing_backend;
    proxy_request_buffering off;  # 大文件流式转发，不在 nginx 暂存
    proxy_http_version 1.1;
    # ... 其他 header 同 /api/
}
```

### 4.5 服务端清理任务

`MediaResource.cleanExpired` 已有机制，扩展到 `uploaded_files`：
- 60 天未使用且无任何 `media_task` 引用 → 软删 + 落盘文件删除
- 跑 cron 每天凌晨执行

---

## 5. Rust 端改造（src-tauri）

### 5.1 拆分 upload.rs

现有 `upload.rs` 是"前端 → Rust 分块上传到本地磁盘"，跟我们要的"Rust → server 上传"语义不同。**拆成两个文件**避免混淆：

- `upload_local.rs`：现有内容，前端 → Rust 本地分块（用于规避 WebView2 3MB IPC 上限）
- `upload_remote.rs`：**新增**，Rust → JiJing server 上传

### 5.2 新增 `upload_remote.rs`

```rust
//! Rust → 服务端文件上传。所有送往上游 AI API 的本地媒体必须先经此 command
//! 转换为 HTTP URL，绝不再走 base64 inline 进 JSON。
//!
//! 与 `upload_local.rs` 区别：
//! - `upload_local`：前端 → Rust 分块（规避 WebView2 IPC 3MB 上限）
//! - `upload_remote`：Rust → 服务端 multipart（规避上游 API body 上限）

use std::path::PathBuf;
use tauri::State;
use sha2::{Sha256, Digest};
use tokio::sync::Semaphore;

use crate::AppState;
use super::config::read_api_config;

/// 全局并发限制：同时最多 4 个上传，防止打爆服务端 + 用户本地网络
static UPLOAD_SEMAPHORE: tokio::sync::OnceCell<Semaphore> = tokio::sync::OnceCell::const_new();

#[derive(Serialize, Deserialize, Debug)]
pub struct UploadResult {
    pub url: String,
    pub sha256: String,
    pub content_type: String,
    pub size: u64,
    pub cached: bool,  // true = 本地或服务端缓存命中，未实际上传
}

#[tauri::command]
pub async fn upload_to_server(
    state: State<'_, AppState>,
    path: String,
) -> Result<UploadResult, String> {
    // 1. 解析路径（支持 local://、相对 media/、绝对路径）
    let abs_path = resolve_media_path(&state, &path)?;

    // 2. 读 metadata（不读全文件）
    let metadata = tokio::fs::metadata(&abs_path).await.map_err(...)?;
    let size = metadata.len();
    if size > MAX_UPLOAD_BYTES {
        return Err(format!("文件超过 {}MB 上限", MAX_UPLOAD_BYTES / (1024 * 1024)));
    }

    // 3. 计算 sha256（流式，避免一次性读入内存）
    let sha256 = compute_sha256_streaming(&abs_path).await?;

    // 4. 查本地缓存
    let server_origin = read_server_origin(&state)?;
    if let Some(cached) = lookup_cache(&state, &sha256, &server_origin).await? {
        update_last_used(&state, &cached.sha256, &server_origin).await?;
        return Ok(UploadResult {
            url: cached.remote_url,
            sha256,
            content_type: cached.content_type,
            size,
            cached: true,
        });
    }

    // 5. 实际上传（带并发限制 + 重试）
    let sem = UPLOAD_SEMAPHORE.get_or_init(|| async { Semaphore::new(4) }).await;
    let _permit = sem.acquire().await.unwrap();
    let result = upload_with_retry(&state, &abs_path, &sha256, &server_origin).await?;

    // 6. 写缓存
    insert_cache(&state, &result, &server_origin).await?;

    Ok(result)
}

/// 流式计算 sha256，64KB chunk，4K 大图也只占 64KB 内存
async fn compute_sha256_streaming(path: &Path) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path).await.map_err(...)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).await.map_err(...)?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

async fn upload_with_retry(
    state: &AppState,
    path: &Path,
    sha256: &str,
    server_origin: &str,
) -> Result<UploadResult, String> {
    let mut attempt = 0;
    let max_attempts = 3;
    loop {
        attempt += 1;
        match upload_once(state, path, sha256).await {
            Ok(r) => return Ok(r),
            Err(e) if attempt >= max_attempts => return Err(e),
            Err(e) if is_retryable(&e) => {
                let backoff_ms = 500 * 2u64.pow(attempt - 1);
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                continue;
            }
            Err(e) => return Err(e),
        }
    }
}

async fn upload_once(state: &AppState, path: &Path, sha256: &str) -> Result<UploadResult, String> {
    let config = read_api_config(&state.db, "jijing")?;
    let file_bytes = tokio::fs::read(path).await.map_err(...)?;
    let mime = mime_from_path(path);
    let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("file.bin");

    let form = reqwest::multipart::Form::new()
        .part("file", reqwest::multipart::Part::bytes(file_bytes)
            .file_name(filename.to_string())
            .mime_str(&mime).map_err(...)?)
        .text("sha256", sha256.to_string());

    let url = format!("{}/v1/files/upload", config.base_url);
    let resp = reqwest::Client::new()
        .post(&url)
        .bearer_auth(&config.api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("网络错误: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {} {}", status, body));
    }

    let data: ApiResponse<FileUploadResponse> = resp.json().await.map_err(...)?;
    data.data.ok_or("空响应")?.into_result()
}
```

### 5.3 SQLite 缓存表

启动时执行 migration：

```rust
const UPLOAD_CACHE_SCHEMA: &str = "
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
CREATE INDEX IF NOT EXISTS idx_uploaded_files_lru ON uploaded_files(last_used_at);
";
```

### 5.4 启动时清理

- 删除 30 天未使用的缓存记录
- 不主动验证远端 URL 是否仍可达（懒验证，下次上传命中再说）

### 5.5 调用方注册

`src-tauri/src/lib.rs` 注册 command：

```rust
.invoke_handler(tauri::generate_handler![
    // ...
    commands::upload_remote::upload_to_server,
])
```

### 5.6 `inline_local_files` 处理（兼容期）

**保留**，但加监控：

```rust
fn inline_local_files(...) -> Result<(), String> {
    match value {
        serde_json::Value::String(s) => {
            if let Some(rel) = s.strip_prefix("local://") {
                tracing::warn!(
                    target: "ai_canvas::legacy",
                    "[ai_proxy] legacy local:// fallback in JSON body — \
                     should have been uploaded to /v1/files/upload first. \
                     rel={}", rel
                );
                // ... 原有 base64 展开逻辑保留
            }
        }
        // ...
    }
}
```

3 个月后监控归零即删除整段。

---

## 6. 前端 TypeScript 改造（src/）

### 6.1 新增 `src/platform/media.ts`（统一入口）

```typescript
import { isTauri, getInvoke } from "./index";
import { buildProxyUrl, getAuthHeaders } from "./ai.api";
import { compressDataUrlForApi } from "@/lib/imageCompression";

interface UploadResult {
  url: string;
  sha256: string;
  contentType: string;
  size: number;
  cached: boolean;
}

/**
 * 把任何本地媒体引用转换为上游 API 可消费的 HTTP URL。
 * 这是 ai-canvas 送出任何媒体的**唯一**入口。
 *
 * 接受的输入：
 * - HTTP/HTTPS URL（原样返回）
 * - `local://<relPath>`（Tauri 占位符）
 * - `data:<mime>;base64,...`（dataURL）
 * - 相对存储路径 `projects/.../media/...`
 * - Vite 前端 asset URL `/src/assets/...` 或 `/assets/...`
 *
 * 输出：HTTPS URL。失败抛 Error，调用方按错误码处理 UX。
 *
 * @throws {Error} 401/403 - 鉴权失败
 * @throws {Error} 413 - 文件过大（已尝试压缩仍失败）
 * @throws {Error} 415 - 不支持的 MIME
 * @throws {Error} 5xx - 服务端故障
 */
export async function mediaToApiRef(input: string): Promise<string> {
  if (!input) return "";

  // 已是 HTTP URL：直传
  if (input.startsWith("http://") || input.startsWith("https://")) {
    return input;
  }

  if (isTauri) {
    // Tauri 模式：交给 Rust 上传（带缓存）
    const result = await getInvoke()<UploadResult>("upload_to_server", { path: input });
    return result.url;
  }

  // Web 模式：dataURL/前端 asset → fetch FormData
  return await uploadInWebMode(input);
}

async function uploadInWebMode(input: string): Promise<string> {
  let blob: Blob;
  let filename: string;

  if (input.startsWith("data:")) {
    blob = await dataUrlToBlob(input);
    filename = `upload.${extFromMime(blob.type)}`;
  } else {
    // 假定是可 fetch 的 URL（前端 asset / blob:URL）
    const resp = await fetch(input);
    blob = await resp.blob();
    filename = input.split("/").pop() || "upload.bin";
  }

  const form = new FormData();
  form.append("file", blob, filename);

  const resp = await fetch(buildProxyUrl("/v1/files/upload"), {
    method: "POST",
    headers: getAuthHeaders(),  // 不要 Content-Type，让浏览器自己加 boundary
    body: form,
  });

  if (!resp.ok) {
    throw new Error(`upload failed: HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return data.data.url;
}
```

### 6.2 标记 `getBase64ForApi` 为 deprecated

```typescript
/**
 * @deprecated 用 `mediaToApiRef` 替代。这个函数返回 `local://` 占位符或 dataURL，
 * 语义混乱，已知导致桌面端绕过压缩 + 撞 IPC 64MB 上限。
 *
 * Phase 4 将移除。新代码不允许调用。
 */
export async function getBase64ForApi(rawUrl: string): Promise<string> {
  warnOnceLegacy("getBase64ForApi is deprecated, use mediaToApiRef");
  // 内部转调新入口，确保即便老调用点没改也走新路
  return mediaToApiRef(rawUrl);
}
```

### 6.3 替换所有调用点

完整清单（每处都要改）：

| 文件 | 行号 | 改法 |
|---|---|---|
| `features/editor/ChatEditor.tsx` | 426, 430, 435, 442, 446, 450 | `getBase64ForApi` → `mediaToApiRef` |
| `stores/chatStore.ts` | 137, 140, 930 | 同上 |
| `lib/promptSerializer.ts` | 110 | 同上 |
| `features/editor/MultiangleEditor.tsx` | 190 | 同上 |
| `features/editor/MediaEditor.tsx` | 460 | 同上 |
| `features/editor/VideoEditor.tsx` | 667, 674, 680, 697 | 同上 |
| `providers/openai-compat/base.ts` | 238, 276 | `compressDataUrlForApi(ref.url)` → `mediaToApiRef(ref.url)` |

### 6.4 删除 `compressDataUrlForApi` 在 provider 出口的调用

它是死代码（桌面端永远空跑）。压缩职责挪到 `mediaToApiRef` 内部"上传前如果 413 自动压缩重试"。函数本体保留（IPC 落盘前那一道仍在用）。

### 6.5 eslint 规则禁止直接调

`.eslintrc.cjs` 增加 `no-restricted-imports`：

```js
{
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector: "CallExpression[callee.name='getBase64ForApi']",
        message: "用 mediaToApiRef 替代（src/platform/media.ts）",
      },
    ],
  },
}
```

### 6.6 进度反馈

`mediaToApiRef` 加可选 `onProgress` 参数，给生图 UI 显示"正在上传 3/6"：

```typescript
export async function mediaToApiRef(
  input: string,
  opts?: { onProgress?: (phase: "uploading" | "done") => void }
): Promise<string>;
```

`OpenAICompatProvider.generateImage` 调用时按数组进度回调：

```typescript
const urls: string[] = [];
for (let i = 0; i < req.referenceImages.length; i++) {
  urls.push(await mediaToApiRef(req.referenceImages[i].url, {
    onProgress: () => req.onProgress?.({ phase: "uploading", current: i + 1, total: req.referenceImages.length })
  }));
}
body[imageField] = urls;
```

---

## 7. 测试计划

### 7.1 服务端（Java）

- `MediaUploadControllerTest`：
  - 正常上传返 200 + URL
  - 同 sha256 第二次上传返 `cached: true` 且不落盘新文件
  - 不同用户相同文件各自有 URL（不跨用户去重）
  - 不在白名单的 MIME 返 415
  - 超过 100MB 返 413
  - 客户端传错 sha256 返 400
  - 未鉴权返 401
  - 速率限制触发返 429
- `Base64ImageSanitizerTest`：保持现有测试，新增"sanitizer 收到 http:// URL 应原样透传不动"

### 7.2 Rust

- `upload_to_server` 缓存命中（mock server，第二次不发出 HTTP）
- 流式 sha256 对 4K 大图正确（与命令行 `sha256sum` 比对）
- 网络断重试 3 次后报错
- 并发 6 个文件实际只 4 个并行（semaphore 测试）
- 不同 server_origin 不共享缓存（切换 provider 重传）
- 鉴权失败 401 不重试

### 7.3 前端

- `mediaToApiRef` 4 种输入分支各有单测
- Tauri 分支 mock invoke 返 URL
- Web 分支 mock fetch
- HTTP URL 直传不调上传

### 7.4 集成测试（手工 + e2e）

- 6 张原图（手机相片各 8MB） → 生图 → JSON body 实测 < 5KB（只含 URL）
- 同一组图二次生成 → Rust 日志显示 `cached: true` × 6 → 总耗时 < 200ms
- 切换 provider → 第一次重传，第二次缓存命中
- 离线状态下点生成 → 报"网络异常"，不出现"64MB"错误
- 改前后做 4K 视频生成全流程比对（视频引用同样走新路）

### 7.5 回归

- chat 视觉模型（GPT-4o / Gemini Pro Vision）问图 → 上传 URL 后 vision 模型能拉取并理解
- 视频参考帧生成（VEO / Seedance）→ URL 传到上游 provider 后能拉取首帧

---

## 8. 监控与可观测

### 8.1 服务端 metrics

- `jijing_files_upload_total{status, mime, cached}` Counter
- `jijing_files_upload_size_bytes{mime}` Histogram
- `jijing_files_upload_duration_seconds{cached}` Histogram
- `jijing_files_dedup_hit_rate` Gauge

### 8.2 客户端日志

Rust:
```
[upload] success path=projects/x/y.jpg sha256=abc... size=8.2MB duration=1240ms cached=false
[upload] cache_hit sha256=abc... duration=12ms
```

### 8.3 Legacy fallback 监控（关键）

Rust `inline_local_files` 走到时 `tracing::warn!`，服务端按 user-agent / 客户端版本分群统计 fallback 计数：
- 目标：1 个月后 fallback 计数 < 1% 总请求
- 3 个月后归零 → 触发 Phase 4 清理

---

## 9. 分阶段实施

### Phase 1：服务端 `/v1/files/upload` 落地（1.5 天）

| 任务 | 优先级 |
|---|---|
| 新增 `MediaUploadController` | P0 |
| 新增 DB 表 `uploaded_files` + Mapper | P0 |
| 新增 `FileUploadResponse` VO | P0 |
| nginx 配置 `/v1/files/upload` 放行 + 速率限制 | P0 |
| 单测 + 集成测试 | P0 |
| metrics 接入 | P1 |

### Phase 2：Rust `upload_remote` command（1.5 天）

| 任务 | 优先级 |
|---|---|
| 拆 `upload.rs` → `upload_local.rs` + `upload_remote.rs` | P0 |
| sqlite migration 加 `uploaded_files` 表 | P0 |
| `upload_to_server` command 实现 + 缓存 | P0 |
| 流式 sha256 + 并发限制 + 重试 | P0 |
| 单测 | P0 |
| 启动清理 LRU | P1 |

### Phase 3：前端统一入口 `mediaToApiRef`（2 天）

| 任务 | 优先级 |
|---|---|
| 新增 `src/platform/media.ts` | P0 |
| `getBase64ForApi` 改为转调 + deprecated 标记 | P0 |
| 7 处调用点全部替换 | P0 |
| eslint 规则禁止 `getBase64ForApi` 直调 | P1 |
| 进度回调接入生图/生视频 UI | P1 |
| `compressDataUrlForApi` 在 provider 出口的调用删除 | P1 |

### Phase 4：验证 + 删除老路（3 个月后）

| 任务 | 触发条件 |
|---|---|
| 监控 `legacy local:// fallback` 计数 | 持续监控 |
| 计数归零后删除 `inline_local_files` Rust 函数 | 监控归零 + 1 周 |
| 删除 `getBase64ForApi` 函数体 | 同上 |
| 删除 `IPC_INLINE_LOCAL_FILES_*` 上限常量 | 同上 |
| 删除 `compressDataUrlForApi` 中 provider 死分支 | 同上 |

### 总工期估算

- Phase 1+2+3 顺序串行（每阶段都依赖前一阶段验证）：**5 天**
- Phase 4：**3 个月后**

---

## 10. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Phase 3 替换调用点漏改某处 | 中 | 漏改的路径仍撞 64MB | eslint 规则拦截 + Rust 端 fallback 监控兜底 |
| 服务端上传端点被滥用 | 低 | 磁盘塞满 | 100MB 单文件上限 + 60 天 LRU 清理 + 速率限制 |
| 上传期间网络不稳定 | 中 | 用户体验差 | 客户端 3 次 retry + 用户可见的"正在上传 N/M"提示 |
| sha256 流式计算慢（500MB 视频） | 低 | 用户等几秒 | 64KB chunk 流式，500MB 视频 sha256 ≈ 800ms，可接受 |
| 服务端域名切换（provider 切换）丢缓存 | 中 | 重传成本 | cache key 含 `server_origin`，切换天然重传，符合预期 |
| `inline_local_files` 删除前用户用老版本客户端 | 高 | 没事 | 老版本走 fallback 路径正常工作 |
| 视频 > 100MB 上传失败 | 中 | 大视频不可用 | Phase 1 不支持，明确报错；Phase 5（计划外）做分块上传 |
| MinIO/S3 切换 | 低 | 需迁移现有 `/uploads` 文件 | `FileStorageService` 已抽象，配置切换即可；URL 通过域名兼容 |

---

## 11. 验收标准

### 必须满足

- [ ] 6 张原相机相片（合计 60MB+）调生图，JSON body < 10KB，全程无错误
- [ ] 同 6 张图二次生成总耗时 < 1s（缓存命中）
- [ ] chat 视觉模型问 6 张图，请求体只含 URL，模型正常理解
- [ ] 离线状态下点生成，UI 明确显示"网络异常"，不出现"64MB"错误
- [ ] Rust legacy fallback 监控接入并可在管理后台查看
- [ ] 服务端 `/v1/files/upload` 端点 swagger 文档完整
- [ ] 所有现有自动化测试通过

### 应该满足

- [ ] `/v1/files/upload` sha256 命中率 > 30%（用户重复使用图片很常见）
- [ ] 单文件上传 P95 < 3 秒（10MB 图，wifi）
- [ ] eslint 拦截 `getBase64ForApi` 新调用
- [ ] 上传中显示进度，超过 2s 显示进度条

### 长期目标（Phase 4）

- [ ] Rust `inline_local_files` 删除
- [ ] `getBase64ForApi`、`local://` 占位符在 JSON body 中绝迹
- [ ] `INLINE_LOCAL_FILES_TOTAL_HARD_LIMIT_BYTES` 常量及其守门常量删除

---

## 12. 不在本计划范围（明确划出）

- **视频分块上传（>100MB）**：Phase 1 走整文件 multipart，超过 100MB 报错。分块上传作为 Phase 5 单独规划。
- **预签名 URL / 直传 S3**：当前规模下 `/v1/files/upload` 直传足够；`FileStorageService` 已预留 `generatePresignedUploadUrl` 接口，未来切换时不影响客户端。
- **服务端 LLM 端点（`/v1/chat/completions`）的 image_url 处理**：服务端 sanitizer 已经覆盖，本计划不动。
- **存量 `media_task.request_params` 含 base64 的清理**：Phase 0 已做（plan 文档 §4.2），不重复。
- **HEIC/AVIF 等特殊格式解码**：前端已有 `heicConverter.ts` 处理，落盘后是 JPEG/PNG，上传链路无需感知。
- **第三方 API 调用方仍发 base64**：服务端 sanitizer 会兜底转 URL，本计划不动。

---

## 13. 决策记录

| 抉择 | 决定 | 替代方案 | 否决理由 |
|---|---|---|---|
| 上传端点路径 | `/v1/files/upload` | 复用 `/consumer/generate/upload` | consumer 路径耦合业务语义，不通用 |
| 鉴权 | Bearer API Key | session cookie | 跟 `/v1/*` 其他端点统一 |
| 文件命名 | sha256 内容寻址 | UUID 随机命名 | sha256 天然去重 + 可缓存 |
| 上传时机 | 生成时按需 | 挂图立即上传 | 失败语义清晰，不浪费 |
| 客户端缓存 | sqlite + sha256 | 不缓存 | 二次生成重传成本太高 |
| 老路保留期 | 3 个月监控后删 | 立即删 | 风险大，老客户端无法兼容 |
| 视频走同通道 | 是 | 视频单独端点 | 同样的 multipart 协议，无理由分裂 |
| Rust upload 文件 | 拆 `upload_remote.rs` | 与 `upload_local.rs` 合并 | 语义完全不同，合并易混淆 |
| 错误重试 | 客户端 3 次 expon backoff | 不重试 | 网络抖动很常见，重试便宜 |
| Web 模式 | 同一入口分支 | 单独 webMediaToApiRef | 调用方不该感知运行环境 |

---

## 14. 参考资料

- JiJing 服务端规划：`JiJing_Server/docs/arch/base64-image-upload-refactor.md`
- ai-canvas Rust IPC 守门常量：`src-tauri/src/commands/ipc_limits.rs`
- 现有 `Base64ImageSanitizer` 实现：`JiJing_Server/jijing-common/jijing-common-storage/src/main/java/com/jijing/common/storage/Base64ImageSanitizer.java`
- OpenAI Files API 风格：<https://platform.openai.com/docs/api-reference/files>
- 性能与 IPC 规范：`docs/性能与IPC规范.md`
