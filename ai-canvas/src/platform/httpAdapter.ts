/**
 * **前端唯一对外网络出口**。
 *
 * ai-canvas 是 Tauri 桌面应用,WebView 只允许加载本地资源 (vite asset / data: /
 * blob: / `tauri://localhost`),**绝不**直接发起跨域 HTTP 请求。所有上行请求
 * 一律走本模块导出的函数 → Tauri invoke → Rust 端 `reqwest` 客户端。
 *
 * ## 为什么这条规矩存在
 *
 * 历史教训 (2026-05-30 CORS 事件):
 *   `media.ts::uploadViaFetch` 在 Tauri **dev** 模式下用浏览器原生 `fetch`
 *   调 `https://api.jjowo.com/v1/files/upload`。dev 模式 WebView origin
 *   是 `http://127.0.0.1:1620` (vite), 服务端 CORS allowlist 不放行 →
 *   preflight 失败, 上传全挂。生产因为 `tauri://localhost` origin 凑巧匹配,
 *   bug 只在 dev 复现 → 任何"绝对 URL fetch 在生产能跑"的设计都是脆弱的。
 *
 * 根治: WebView **永远不直接发上行请求**。CORS / cookie / referer /
 * mixed-content / 代理链等浏览器层复杂性, 在桌面端**不应该存在**。
 *
 * ## 三个导出
 *
 * 1. [`httpJson`] —— 通用 JSON 调用 (auth API / update API / 任意远程 REST)。
 *    走 Rust `http_request` command, 接受任意完整 URL + method + headers + body。
 *
 * 2. [`httpUploadBytes`] —— 媒体上传 (data: / blob: / vite asset 内存 bytes)。
 *    走 Rust `upload_bytes_to_server` command, 复用 sqlite 缓存 + in-flight
 *    单飞 + 双 semaphore 治理。大 bytes 自动 fallback 到 `upload_media_chunk`
 *    分块路径再走 `upload_to_server`, 绕过 IPC 3MB 上限。
 *
 * 3. (未导出) AI provider 调用 → 见 `ai.api.ts::aiProxy` / `aiProxyStream`,
 *    内部走 `ai_proxy` / `ai_proxy_stream` invoke。它们的 Web 分支已删,
 *    仅保留 Tauri 路径。
 *
 * ## 反规范红线
 *
 * 以下用法**禁止**, ESLint 规则 + `check-ipc-guards.mjs` 会拦截:
 *
 *   - `fetch("https://...")` / `fetch("http://...")` 任何形态
 *   - `new XMLHttpRequest()` / `new EventSource()` / 第三方 HTTP 库
 *   - 在 `platform/` 以外的代码 import `buildProxyUrl`, `resolveProviderEndpoint`,
 *     `getProviderAbsoluteBaseUrl` —— 这些已被删除。
 *
 * 唯一合规的 `fetch` 用法是把 `data:` / `blob:` / 同源 vite asset 解析成 Blob,
 * 例如本模块内部的 [`resolveToBlob`]。
 */

import { isTauri, ensureTauriAPIs, getInvoke } from "./runtime";

// ── Tauri 单次 invoke 字节上限 ────────────────────────────────────────────
//
// WebView2 IPC 通道单次 payload 大约 3MB。bytes 通过 invoke 传给 Rust 时,
// Tauri 序列化 + base64 编码会产生 ~33% overhead, 留余量按 2.5MB 切。
// 超过这个阈值, httpUploadBytes 自动转走 chunked path:
//   前端 base64 切片 → upload_media_chunk → temp 文件 → upload_to_server。
//
// 跟 Rust 端 `ipc_limits::IPC_PAYLOAD_HARD_LIMIT_BYTES` 对齐 (留一致余量),
// 改动两边必须同步。
const BYTES_DIRECT_INVOKE_LIMIT = 2.5 * 1024 * 1024;

// ── 通用 HTTP (httpJson) ──────────────────────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD";

export interface HttpJsonOptions {
  /** 完整 URL, 必须 http:// 或 https://。 */
  url: string;
  /** 默认 GET。 */
  method?: HttpMethod;
  /**
   * 请求体: object 自动 JSON 序列化 + 注入 `Content-Type: application/json`;
   * string 原样发, Content-Type 由调用方在 `headers` 里自己声明。
   */
  body?: unknown;
  /** 自定义请求头, key 大小写不敏感。Authorization 由调用方负责注入。 */
  headers?: Record<string, string>;
}

/** Rust `http_request` 命令的返回。 */
export interface HttpResponse {
  status: number;
  body: string;
  /** header key 已小写。 */
  headers: Record<string, string>;
}

/**
 * 通用上行 HTTP。**Tauri only** —— Web 模式直接 throw, 避免静默回退到原生 fetch
 * 引入 CORS / cookie 等不确定行为。
 *
 * 调用方拿到 `HttpResponse` 后自己 `JSON.parse(body)`, 因为本函数不知道目标
 * API 的响应 schema。
 *
 * 错误语义: Rust 端瞬时连接错误自动重试 (`send_with_retry`), 4xx/5xx 返
 * 正常响应交给调用方判断。reqwest 完全失败时本函数 throw。
 */
export async function httpJson(opts: HttpJsonOptions): Promise<HttpResponse> {
  if (!isTauri) {
    throw new Error(
      "[httpAdapter] httpJson 仅支持 Tauri 模式。前端不允许在 Web 上直接发出站请求 (CORS 规约)。",
    );
  }

  if (!opts.url.startsWith("http://") && !opts.url.startsWith("https://")) {
    throw new Error(
      `[httpAdapter] url 必须以 http:// 或 https:// 开头 (收到: ${opts.url})`,
    );
  }

  await ensureTauriAPIs();

  // body 透传:object → JSON.value (Rust 自动序列化), string → string 原样。
  // 这两种走 Rust 端 HttpRequestBody untagged enum 各自分支。
  let bodyForInvoke: unknown = undefined;
  if (opts.body !== undefined && opts.body !== null) {
    if (typeof opts.body === "string") {
      bodyForInvoke = opts.body;
    } else {
      bodyForInvoke = opts.body;
    }
  }

  return await getInvoke()<HttpResponse>("http_request", {
    url: opts.url,
    method: opts.method ?? "GET",
    body: bodyForInvoke,
    headers: opts.headers,
  });
}

/**
 * `httpJson` 的便捷包装: 自动 `JSON.parse(body)` 并把 non-2xx 翻成 throw。
 *
 * 适合**所有响应都是 JSON** 的端点 (auth API, update API 等)。对返回 HTML
 * 错误页 / 非 JSON 的端点请直接用 `httpJson` 并手动判 status。
 */
export async function httpJsonRequest<T = unknown>(opts: HttpJsonOptions): Promise<T> {
  const resp = await httpJson(opts);
  if (resp.status < 200 || resp.status >= 300) {
    // 尝试解 body 拿后端错误信息, 拿不到就用 HTTP 状态描述。
    const bodyPreview = resp.body.length > 500 ? `${resp.body.slice(0, 500)}…` : resp.body;
    throw new Error(`HTTP ${resp.status}: ${bodyPreview}`);
  }
  if (!resp.body) {
    return undefined as T;
  }
  try {
    return JSON.parse(resp.body) as T;
  } catch (e) {
    throw new Error(
      `[httpAdapter] 响应不是合法 JSON (url=${opts.url}, status=${resp.status}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

// ── 媒体 bytes 上传 (httpUploadBytes) ─────────────────────────────────────

export interface UploadResult {
  url: string;
  sha256: string;
  contentType: string;
  size: number;
  /** true = 命中本地或服务端缓存, 没有实际产生上传 HTTP */
  cached: boolean;
}

export interface UploadBytesOptions {
  /** 默认 jijing。 */
  provider?: string;
  /**
   * 预热模式 —— 用户拖入/粘贴后台静默上传时设 true, Rust 端走
   * PREWARM_SEMAPHORE(2) 不挤占主路径 MAIN_SEMAPHORE(4)。
   */
  prewarm?: boolean;
}

/**
 * 把任意 WebView 端可拿到的资源 (data: / blob: / vite asset / 同源 URL) 上传到
 * JiJing server。**Tauri only**。
 *
 * 实现路径:
 * 1. `resolveToBlob(input)` —— WebView 内部 fetch, 拿到 Blob
 * 2. < BYTES_DIRECT_INVOKE_LIMIT (2.5MB) → invoke `upload_bytes_to_server`
 *    (一次调用直接走 Rust multipart, 复用 sha256 缓存 + 单飞 + semaphore)
 * 3. >= 上限 → invoke `upload_media_chunk` (base64 分块写到 temp 文件) →
 *    再 invoke `upload_to_server`, 走与文件路径完全相同的链路
 *
 * 两条路径产物都是 [`UploadResult`], 调用方完全无感知。
 *
 * @param input  data: / blob: / 同源 URL / vite asset 路径 (如 `/src/...`)
 * @param opts   provider (默认 jijing) + prewarm (默认 false)
 */
export async function httpUploadBytes(
  input: string,
  opts?: UploadBytesOptions,
): Promise<UploadResult> {
  if (!isTauri) {
    throw new Error(
      "[httpAdapter] httpUploadBytes 仅支持 Tauri 模式。前端不允许直接 fetch 上游 (CORS 规约)。",
    );
  }

  const provider = opts?.provider ?? "jijing";
  const prewarm = opts?.prewarm ?? false;

  await ensureTauriAPIs();

  const blob = await resolveToBlob(input);
  const filename = guessFilename(input, blob.type);
  const contentType = blob.type || "application/octet-stream";
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (bytes.byteLength < BYTES_DIRECT_INVOKE_LIMIT) {
    // 直传路径 —— 一次 invoke 把 bytes 喂给 Rust, Rust 走 multipart 上传
    return await getInvoke()<UploadResult>("upload_bytes_to_server", {
      bytes: Array.from(bytes),
      filename,
      contentType,
      provider,
      prewarm,
    });
  }

  // 分块路径 —— bytes 太大, base64 切片走 upload_media_chunk + upload_to_server。
  // 流程跟 lib/media.ts 里用户文件上传一致, 复用现有 chunked pipeline 不重新发明。
  return await uploadViaChunkedPipeline(bytes, filename, contentType, provider, prewarm);
}

/**
 * 大 bytes (>2.5MB) 的兜底路径:base64 切片 → Rust temp 文件 → upload_to_server。
 *
 * 跟 `lib/media.ts::uploadFileToTempPath` 用的是同一组 Rust command, 区别只是
 * 数据源是 ArrayBuffer 而不是用户选择的 `File`。
 */
async function uploadViaChunkedPipeline(
  bytes: Uint8Array,
  filename: string,
  contentType: string,
  provider: string,
  prewarm: boolean,
): Promise<UploadResult> {
  const uploadId = crypto.randomUUID();
  // upload_media_chunk 校验长度 16..=64, UUID v4 是 36 字符, 合法。

  // ipc_guard 限 1.8MB base64 / chunk, 留余量按 1.5MB 原始字节 (base64 编码后 ~2MB) 切。
  const CHUNK_SIZE = 1.5 * 1024 * 1024;
  const totalChunks = Math.ceil(bytes.byteLength / CHUNK_SIZE);

  try {
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, bytes.byteLength);
      const slice = bytes.slice(start, end);
      const base64 = bytesToBase64(slice);

      // 顺序上传 — Tauri IPC 在同一 window 是 FIFO, await 保证 Rust 看到顺序
      await getInvoke()<number>("upload_media_chunk", {
        uploadId,
        base64Chunk: base64,
      });
    }

    // temp 文件已写完, 直接让 upload_to_server 读 temp 路径上传。
    // 不经过 save_media 持久化, 因为 data:/blob:/vite asset 是临时资源,
    // 用户没主动"保存"它们; upload_to_server 的 resolve_input_path 接受
    // `media/<rel>` 子树相对路径, temp 文件就在 `media/uploads_temp/<uuid>`,
    // 路径合法且不越权。
    //
    // 流式读 temp 文件算 sha256 跟 bytes 直传计算结果一致 (单测
    // `sha256_path_and_bytes_agree` 覆盖), 所以缓存命中行为两条路径无差异。
    const tempSource = `media/uploads_temp/${uploadId}`;
    const result = await getInvoke()<UploadResult>("upload_to_server", {
      path: tempSource,
      provider,
      prewarm,
    });
    // filename 用于服务端 multipart 显示文件名, temp 路径里是 uuid 没扩展名,
    // 上传完拿到 server URL 后这个值已落到 sqlite uploaded_files 表, 不再需要。
    void filename;
    void contentType;
    return result;
  } finally {
    // upload_media_cleanup 出错不影响上传结果 — 孤儿 temp 文件会在下次启动时
    // 由 cleanup_orphan_uploads_on_startup 兜底清理。
    try {
      await getInvoke()("upload_media_cleanup", { uploadId });
    } catch {
      /* ignore — startup cleanup will sweep */
    }
  }
}

// ── 工具: 把 WebView 端的资源解析成 Blob ────────────────────────────────

/**
 * 把 input (data: / blob: / 同源 URL / vite asset 路径) 解析成 Blob。
 *
 * 这里的 `fetch` 不调上游 —— 都是 **WebView 内部资源** (data URL / blob URL /
 * vite dev server 自己的 asset)。ESLint 规则会区分:`fetch("https://...")`
 * 禁止, `fetch(localOrDataUrl)` 允许。本函数是合规 fetch 的样板。
 */
async function resolveToBlob(input: string): Promise<Blob> {
  if (input.startsWith("data:")) {
    return dataUrlToBlob(input);
  }
  // blob: / 同源 URL / vite asset 都能用浏览器 fetch
  const resp = await fetch(input);
  if (!resp.ok) {
    throw new Error(`无法读取本地媒体 (${resp.status}): ${input}`);
  }
  return await resp.blob();
}

function dataUrlToBlob(dataUrl: string): Blob {
  const commaIdx = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || commaIdx < 0) {
    throw new Error("非合法 dataURL");
  }
  const meta = dataUrl.slice(5, commaIdx);
  const isBase64 = meta.endsWith(";base64");
  const mime = isBase64 ? meta.slice(0, -7) : meta;
  const payload = dataUrl.slice(commaIdx + 1);
  if (isBase64) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime || "application/octet-stream" });
  }
  return new Blob([decodeURIComponent(payload)], { type: mime || "text/plain" });
}

function guessFilename(input: string, mime: string): string {
  if (input.startsWith("data:")) {
    return `upload.${extFromMime(mime)}`;
  }
  const tail = input.split(/[?#]/)[0]!.split("/").pop();
  if (tail && tail.includes(".")) return tail;
  return `upload.${extFromMime(mime)}`;
}

function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  if (m === "image/gif") return "gif";
  if (m === "video/mp4") return "mp4";
  if (m === "video/webm") return "webm";
  if (m === "video/quicktime") return "mov";
  if (m === "audio/mpeg") return "mp3";
  if (m === "audio/wav") return "wav";
  return "bin";
}

/**
 * Uint8Array → base64。WebView 没有 Buffer, 走 btoa + chunked 处理避免
 * `String.fromCharCode(...largeArray)` 栈溢出。
 */
function bytesToBase64(bytes: Uint8Array): string {
  // 8KB chunk —— 跟 lib/media.ts 历史实现保持一致, 避免 V8 字符串拼接慢路径。
  const CHUNK = 0x2000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
