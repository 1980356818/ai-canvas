import { saveMedia } from "@/platform/media.api";
import { isTauri } from "@/platform/runtime";
import {
  IPC_SINGLE_INVOKE_SAFE_RAW_BYTES,
  MEDIA_UPLOAD_CHUNK_RAW_BYTES,
  MEDIA_TRANSFER_TOTAL_BYTES,
} from "@/lib/ipcLimits";

let _basePath: string | null = null;
let _convertFileSrc: ((path: string, protocol?: string) => string) | null = null;
let _invoke: typeof import("@tauri-apps/api/core").invoke | null = null;

async function ensureInvoke() {
  if (!_invoke) {
    const core = await import("@tauri-apps/api/core");
    _invoke = core.invoke;
  }
  return _invoke;
}

/**
 * Must be called once at app startup (in Tauri environment).
 * Caches the app_data_dir base path and convertFileSrc function.
 */
export async function initMediaService(): Promise<void> {
  if (!isTauri) return;

  const invoke = await ensureInvoke();
  _basePath = await invoke<string>("get_media_base_path");

  const core = await import("@tauri-apps/api/core");
  _convertFileSrc = core.convertFileSrc;
}

export interface PersistImageResult {
  localPath: string;
  width?: number;
  height?: number;
}

/**
 * 把图像 dataUrl 压到 IPC 安全大小(再大也无解的情况返回原值,由 persistImage
 * 检测后改走分块上传)。
 *
 * 视频/音频 dataURL 直接原样返回 —— `compressDataUrlForApi` 走的是
 * `createImageBitmap` / `<img>` 解码管线,对非图像 MIME 必定失败回退到原值,
 * 中间还会 `fetch(dataUrl)` 一次(~ 2× 文件大小的内存峰值)。对视频纯属浪费。
 * 视频 dataURL 如果超 IPC 上限,persistImage 会**转 Blob 再走分块上传**,
 * 不再撞 WebView2 雷区。
 */
async function ensureIpcSafeDataUrl(dataUrl: string): Promise<string> {
  if (dataUrl.length <= IPC_SINGLE_INVOKE_SAFE_RAW_BYTES) return dataUrl;

  if (/^data:(video|audio)\//i.test(dataUrl)) {
    return dataUrl;
  }

  const { compressDataUrlForApi } = await import("@/lib/imageCompression");

  let safe = await compressDataUrlForApi(dataUrl, {
    maxDim: 2048,
    maxBytes: 1.5 * 1024 * 1024,
    jpegQuality: 0.82,
    forceJpeg: true,
  });

  if (safe.length > IPC_SINGLE_INVOKE_SAFE_RAW_BYTES) {
    safe = await compressDataUrlForApi(safe, {
      maxDim: 1280,
      maxBytes: 1 * 1024 * 1024,
      jpegQuality: 0.7,
      forceJpeg: true,
    });
  }

  return safe;
}

// ── 大文件分块上传 ───────────────────────────────────────────────────
//
// IPC 单次 invoke 安全上限 3MB,但用户拖入的视频/原图常常远大于此。
// 流程见 src-tauri/src/commands/upload.rs 顶部注释。

/** ArrayBuffer → base64 字符串。 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // btoa(String.fromCharCode(...bytes)) 在 > 100KB 时会触发 RangeError(参数数量上限),
  // 必须分段拼。32KB chunk 是参数数量 / 性能的折中。
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return btoa(binary);
}

/** Blob / File → dataURL 字符串。 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}

/** dataURL → Blob。失败抛 Error。 */
function dataUrlToBlob(dataUrl: string): Blob {
  // data:<mime>;base64,<payload>
  const commaIdx = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || commaIdx < 0) {
    throw new Error("非合法 dataURL");
  }
  const meta = dataUrl.slice(5, commaIdx); // e.g. "image/png;base64"
  const isBase64 = meta.endsWith(";base64");
  const mime = isBase64 ? meta.slice(0, -7) : meta;
  const payload = dataUrl.slice(commaIdx + 1);
  if (isBase64) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime || "application/octet-stream" });
  }
  // 非 base64 (rare) - URL-decode the payload as text
  return new Blob([decodeURIComponent(payload)], {
    type: mime || "text/plain",
  });
}

/**
 * 大文件分块上传 —— 走 Tauri commands `upload_media_chunk` + `save_media` +
 * `upload_media_cleanup`。视频 / 超 IPC 上限的大图必走这条路径,
 * 否则单次 invoke 撞 WebView2 雷区。
 *
 * 流程详见 `src-tauri/src/commands/upload.rs` 顶部注释。
 *
 * 上限:文件 size ≤ `MEDIA_TRANSFER_TOTAL_BYTES` (500MB)。再大前端直接拒,
 * 不浪费一通分块发送再被后端 reject。
 */
async function persistLargeFile(
  file: File | Blob,
  title?: string,
  projectId?: string,
): Promise<PersistImageResult> {
  if (!isTauri) {
    // 浏览器 dev 模式:回到 dataURL 路径
    const dataUrl = await blobToDataUrl(file);
    return persistImage(dataUrl, title, projectId);
  }
  if (file.size > MEDIA_TRANSFER_TOTAL_BYTES) {
    throw new Error(
      `文件 ${(file.size / (1024 * 1024)).toFixed(1)}MB 超过 ${MEDIA_TRANSFER_TOTAL_BYTES / (1024 * 1024)}MB 单文件上限,请压缩或裁剪后重试`,
    );
  }

  const invoke = await ensureInvoke();
  const uploadId = crypto.randomUUID();
  const filename = file instanceof File ? file.name : undefined;

  try {
    // 顺序追加 chunk —— **不能并行**:后端按 file size + append 序列化,并行会撞
    // race(虽然 Tauri IPC 在同窗口是 FIFO 的,但 await 是稳妥写法)。
    for (let offset = 0; offset < file.size; offset += MEDIA_UPLOAD_CHUNK_RAW_BYTES) {
      const slice = file.slice(offset, offset + MEDIA_UPLOAD_CHUNK_RAW_BYTES);
      const ab = await slice.arrayBuffer();
      const base64 = arrayBufferToBase64(ab);
      await invoke<number>("upload_media_chunk", {
        uploadId,
        base64Chunk: base64,
      });
    }

    // Finalize:save_media 读 temp 文件,移到 media/images/,magic-byte 校正扩展名。
    //
    // 必须走 `saveMedia` wrapper 而不是直接 invoke —— Rust `SaveMediaResult`
    // 序列化用默认 snake_case (`local_path`),wrapper 里统一做了 snake→camel
    // 翻译。直接 invoke 拿到的 `result.localPath` 永远是 undefined,卡片
    // `videoUrl` 设成 undefined,VideoPreview 走"AI 视频"占位符 = 空卡。
    // 视频几乎必 >1.5MB 全走这条路径,所以"拖视频必空、拖图片正常"。
    return await saveMedia(
      `media/uploads_temp/${uploadId}`,
      filename,
      title,
      projectId,
    );
  } finally {
    // 不论成功失败,清掉 temp 文件 —— 万一这里也失败,启动期 cleanup 会兜底。
    try {
      await invoke("upload_media_cleanup", { uploadId });
    } catch {
      // best-effort
    }
  }
}

/**
 * 持久化 File / Blob 到本地存储。
 *
 * 自动按 size 分流:
 *   - ≤ `IPC_SINGLE_INVOKE_SAFE_RAW_BYTES` (1.5MB):走 dataURL + 单 invoke
 *   - 超过:走 `persistLargeFile` 分块上传
 *
 * 所有"用户从浏览器拖入 File"的入口都应走这里(而不是手动 readFileAsDataUrl
 * + persistImage),让 IPC 安全分流由这里统一处理。
 */
export async function persistFile(
  file: File | Blob,
  title?: string,
  projectId?: string,
): Promise<PersistImageResult> {
  if (!isTauri) {
    const dataUrl = await blobToDataUrl(file);
    return persistImage(dataUrl, title, projectId);
  }
  if (file.size <= IPC_SINGLE_INVOKE_SAFE_RAW_BYTES) {
    const dataUrl = await blobToDataUrl(file);
    return persistImage(dataUrl, title, projectId);
  }
  const inferredTitle =
    title ?? (file instanceof File ? file.name : undefined);
  return persistLargeFile(file, inferredTitle, projectId);
}

/**
 * Save any image source (data URL, HTTP URL, local path) to local storage.
 * When `projectId` is provided, auto-saved copies are organized into
 * a project-specific subfolder: `{title}_{short_id}/`.
 *
 * 大 dataURL 的安全分流逻辑(三级):
 *   1. 先 `ensureIpcSafeDataUrl` 尝试压缩到 IPC 安全大小(JPEG, maxDim)
 *   2. 压完仍然超 → 转 Blob 走 `persistLargeFile` 分块上传(根治 IPC 雷区)
 *   3. 不是 dataURL(HTTP URL / local path) → 直接 saveMedia(IPC payload 不大)
 *
 * 这样调用方不用关心 size,统一交给本函数路由。
 */
export async function persistImage(
  source: string,
  title?: string,
  projectId?: string,
): Promise<PersistImageResult> {
  if (!isTauri) return { localPath: source };

  let result: PersistImageResult;

  if (source.startsWith("data:")) {
    const safe = await ensureIpcSafeDataUrl(source);
    if (safe.length > IPC_SINGLE_INVOKE_SAFE_RAW_BYTES) {
      // 压不下去(典型场景:视频 dataURL,或图像压完仍然 > 1.5MB)
      // → 转 Blob 改走分块上传,而不是硬塞 IPC 撞雷区
      const blob = dataUrlToBlob(safe);
      result = await persistLargeFile(blob, title, projectId);
    } else {
      const saved = await saveMedia(safe, undefined, title, projectId);
      result = { localPath: saved.localPath, width: saved.width, height: saved.height };
    }
  } else {
    // 非 dataURL source(HTTP URL / local path / asset://)— IPC payload 只是个短字符串,
    // 真正的下载/读取在 Rust 端做,无 IPC size 顾虑
    const saved = await saveMedia(source, undefined, title, projectId);
    result = { localPath: saved.localPath, width: saved.width, height: saved.height };
  }

  // 落盘成功后 fire-and-forget 后台预热上传到服务端。
  // 失败完全静默(没缓存就静默, 真正用的时候主路径会再发一次)。
  // 走 prewarm semaphore(2), 不抢主路径(4) 的并发额度。
  // 跟主路径共享 in-flight 单飞 — 预热和主路径撞同一文件时只发一次 HTTP。
  schedulePrewarmUpload(result.localPath);

  return result;
}

/**
 * 后台预热上传 — 转调 `platform/media.ts::prewarmMedia` 统一入口。
 * 这一层 wrapper 保留是为了让 `persistImage` 调用点不用改;新代码请直接
 * 调 `prewarmMedia`。dynamic import 是为了避开 `lib ↔ platform` 的循环。
 */
function schedulePrewarmUpload(localPath: string): void {
  if (!localPath) return;
  void import("@/platform/media").then(({ prewarmMedia }) => prewarmMedia(localPath));
}

function stripQueryAndHash(path: string): string {
  return path.split(/[?#]/, 1)[0] ?? path;
}

function getSameOriginAssetPath(source: string): string | null {
  const value = source.trim();
  if (!value) return null;

  if (value.startsWith("/")) return stripQueryAndHash(value);
  if (value.startsWith("./assets/")) return stripQueryAndHash(value.slice(1));
  if (value.startsWith("assets/")) return `/${stripQueryAndHash(value)}`;

  if (typeof window === "undefined") return null;

  try {
    const url = new URL(value, window.location.href);
    return url.origin === window.location.origin ? url.pathname : null;
  } catch {
    return null;
  }
}

function getFrontendAssetFetchUrl(source: string): string {
  const value = source.trim();
  if (value.startsWith("./assets/")) return value.slice(1);
  if (value.startsWith("assets/")) return `/${value}`;
  return source;
}

/**
 * Vite-imported assets are displayable by the WebView (e.g. `/src/assets/...`
 * in dev or `/assets/...` after build), but they are not filesystem paths that
 * the Tauri backend can read directly.
 */
export function isFrontendAssetUrl(source: string): boolean {
  const pathname = getSameOriginAssetPath(source);
  return !!pathname && (pathname.startsWith("/src/assets/") || pathname.startsWith("/assets/"));
}

export async function urlToDataUrl(source: string): Promise<string> {
  const fetchUrl = getFrontendAssetFetchUrl(source);
  const resp = await fetch(fetchUrl);
  if (!resp.ok) {
    throw new Error(`读取模板资源失败 '${source}': HTTP ${resp.status}`);
  }

  const blob = await resp.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(`读取模板资源失败 '${source}'`));
    reader.readAsDataURL(blob);
  });
}

export async function persistFrontendAsset(
  source: string,
  title?: string,
  projectId?: string,
): Promise<PersistImageResult> {
  if (!isTauri) return { localPath: source };

  const dataUrl = await urlToDataUrl(source);
  return persistImage(dataUrl, title, projectId);
}

// ── URL 格式约定 ────────────────────────────────────────────
//
//   存储层 (storagePath)   media/images/xxx.jpg          相对路径，落盘 / 持久化后的唯一标准格式
//   显示层 (displayUrl)    asset://localhost/<encoded>    Tauri webview 零拷贝加载；或 data:/http:/blob:
//   API 层 (apiValue)      local://media/images/xxx.jpg  IPC 占位符，Rust ai_proxy 在发请求前内联为 base64
//
//   所有对外存储（card.data、chatMessage.content、refImages）只允许 storagePath。
//   normalizeToStoragePath() 是唯一的"脏 URL → storagePath"入口。
// ─────────────────────────────────────────────────────────────

/**
 * **统一归一化入口** — 把任意格式的媒体 URL 转成 storagePath。
 *
 * - `asset://localhost/...`  → 反解为相对路径  (`media/images/xxx.jpg`)
 * - 已经是相对路径            → 原样返回
 * - 需要落盘的格式 (data: / blob: / http(s):)  → 返回 `null`，调用方应走 `persistImage()`
 * - Vite 前端 asset (`/assets/...`)             → 返回 `null`
 *
 * 设计原则：只做无副作用的字符串变换，不读文件、不写盘。
 */
export function normalizeToStoragePath(url: string): string | null {
  if (!url) return null;

  // asset:// (mac/Linux) 或 http(s)://asset.localhost (Windows/Android 的
  // convertFileSrc 产物) → 反解为相对存储路径。两种协议指向同一本机文件,
  // 只反解协议头不同。漏掉 http 形态会让 Windows 下的显示 URL 被当成「需落盘
  // 的远端 URL」(返回 null) 进而被原样持久化进 card.data, 再送上游 → 502。
  if (url.startsWith("asset://") || isAssetHttpHostUrl(url)) {
    return assetUrlToRelPath(url);
  }

  // 已经是干净的相对存储路径
  if (isRelativeStoragePath(url)) {
    return url;
  }

  // local:// 占位符 — 剥掉前缀取相对路径
  if (url.startsWith("local://")) {
    const rel = url.slice("local://".length);
    return isRelativeStoragePath(rel) ? rel : null;
  }

  // 需要落盘才能变成 storagePath
  return null;
}

/**
 * 判断字符串是否已经是合法的相对存储路径。
 * 合法条件：不含协议前缀 / 不以 `/` 或 `\` 开头。
 */
function isRelativeStoragePath(s: string): boolean {
  if (!s) return false;
  if (
    s.startsWith("data:") ||
    s.startsWith("blob:") ||
    s.startsWith("http://") ||
    s.startsWith("https://") ||
    s.startsWith("asset://") ||
    s.startsWith("local://") ||
    s.startsWith("/") ||
    s.startsWith("\\")
  ) {
    return false;
  }
  // Vite 前端 asset
  if (isFrontendAssetUrl(s)) return false;
  return true;
}

/**
 * 是否为 Windows/Android `convertFileSrc` 产出的 asset 显示 URL
 * (`http://asset.localhost/...` 或配了 https scheme 时的 `https://asset.localhost/...`)。
 * mac/Linux 的 `asset://localhost/...` 由调用方单独按 `asset://` 前缀判, 不在此列。
 */
function isAssetHttpHostUrl(url: string): boolean {
  return (
    url.startsWith("http://asset.localhost/") ||
    url.startsWith("https://asset.localhost/")
  );
}

/**
 * asset://localhost/<encoded-abs-path>(或 http(s)://asset.localhost/<encoded-abs-path>)
 * → 相对路径 (media/images/xxx.jpg)。不在 _basePath 内则返回 null。
 */
function assetUrlToRelPath(assetUrl: string): string | null {
  if (!_basePath) return null;

  // 引擎无关反解(理由同 src/platform/media.ts::tauriAssetUrlToLocalPath):**不用
  // `new URL()`** —— 取 host 后段 + 一次 decodeURIComponent → 本机绝对路径, 再剥掉
  // _basePath 前缀得相对 storagePath。纯字符串解析在 WKWebView/WebKit 上与 Chromium
  // 一致, 避开 macOS 把 asset:// 显示 URL 当成"需落盘的远端 URL"误存进 card.data。
  let afterHost: string | null = null;
  if (assetUrl.startsWith("http://asset.localhost/")) {
    afterHost = assetUrl.slice("http://asset.localhost/".length);
  } else if (assetUrl.startsWith("https://asset.localhost/")) {
    afterHost = assetUrl.slice("https://asset.localhost/".length);
  } else if (assetUrl.startsWith("asset://")) {
    const rest = assetUrl.slice("asset://".length);
    const slash = rest.indexOf("/");
    if (slash >= 0) afterHost = rest.slice(slash + 1);
  }
  if (afterHost === null) return null;

  const enc = afterHost.split(/[?#]/, 1)[0] ?? afterHost;
  let absPath: string;
  try {
    absPath = decodeURIComponent(enc);
  } catch {
    return null;
  }

  // 绝对路径 → 相对 storagePath:统一 `/` 分隔后剥掉 _basePath 前缀。
  const normBase = _basePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normAbs = absPath.replace(/\\/g, "/");
  const prefix = normBase + "/";
  if (!normAbs.startsWith(prefix)) return null;
  const rel = normAbs.slice(prefix.length);
  return rel || null;
}

/**
 * Convert a stored relative path to a URL that `<img src>` can display.
 * Uses Tauri's asset protocol for zero-copy file loading.
 * Passthrough for data:/http:/blob: URLs.
 */
export function getDisplayUrl(storedPath: string): string {
  if (!storedPath) return "";

  // 防御：如果入参是 asset:// 显示 URL，直接原样返回（不二次转换）
  if (storedPath.startsWith("asset://")) return storedPath;

  if (
    storedPath.startsWith("blob:") ||
    storedPath.startsWith("http://") ||
    storedPath.startsWith("https://") ||
    storedPath.startsWith("data:") ||
    storedPath.startsWith("/")
  ) {
    return storedPath;
  }

  if (_convertFileSrc && _basePath) {
    const sep = _basePath.includes("\\") ? "\\" : "/";
    const absPath = _basePath + sep + storedPath.replace(/\//g, sep);
    return _convertFileSrc(absPath);
  }

  return storedPath;
}

/**
 * @deprecated 用 {@link import("@/platform/media").mediaToApiRef} 替代。
 *
 * 这个函数的设计有根本缺陷:Tauri 模式返回 `local://` 占位符,Rust 端 inline
 * 成 base64 塞 JSON,会撞 4 道墙 (IPC 3MB / ipc_guard 64MB / nginx 100MB /
 * MySQL request_params)。详见 docs/media-upload-refactor.md。
 *
 * 为兼容已上线版本, 内部转调 mediaToApiRef (走 /v1/files/upload 拿 HTTP URL)。
 * Phase 4 (3 个月监控期满) 会删除函数本体。新代码不允许直接调用。
 */
export async function getBase64ForApi(rawUrl: string): Promise<string> {
  warnDeprecatedOnce("getBase64ForApi");
  // 转调统一入口, 确保即便老调用点没改完也走 HTTP URL 路径
  const { mediaToApiRef } = await import("@/platform/media");
  return mediaToApiRef(rawUrl);
}

let _deprecatedWarned: Set<string> | null = null;
function warnDeprecatedOnce(name: string) {
  if (!_deprecatedWarned) _deprecatedWarned = new Set();
  if (_deprecatedWarned.has(name)) return;
  _deprecatedWarned.add(name);
  // eslint-disable-next-line no-console
  console.warn(
    `[ai-canvas] ${name} is deprecated — use mediaToApiRef from @/platform/media. ` +
      `See docs/media-upload-refactor.md`
  );
}

/**
 * Export an image or video to the user's configured export directory.
 * Filename is built by the Rust side (`build_friendly_filename`), always
 * includes a UUID short-id so `find_file_by_id` / "在文件夹中显示" can locate it.
 */
export async function exportFile(
  storedPath: string,
  cardTitle: string,
  projectId?: string,
): Promise<string> {
  if (!isTauri) return storedPath;

  const invoke = await ensureInvoke();
  return invoke<string>("export_file", {
    sourcePath: storedPath,
    title: cardTitle || null,
    projectId: projectId ?? null,
  });
}

/**
 * Open the system file explorer and highlight the given file.
 * When an auto-save path is configured, opens the user's project folder instead.
 */
export async function revealInExplorer(storedPath: string, projectId?: string): Promise<void> {
  if (!isTauri) return;
  const invoke = await ensureInvoke();
  await invoke("open_in_explorer", { path: storedPath, projectId: projectId ?? null });
}

/**
 * Batch export multiple media files. Returns counts of successes and failures.
 */
export async function batchExportFiles(
  items: { storedPath: string; cardTitle: string; projectId?: string }[],
): Promise<{ success: number; failed: number }> {
  if (!isTauri || items.length === 0) return { success: 0, failed: 0 };

  const invoke = await ensureInvoke();
  let success = 0;
  let failed = 0;

  for (const { storedPath, cardTitle, projectId } of items) {
    try {
      await invoke<string>("export_file", {
        sourcePath: storedPath,
        title: cardTitle || null,
        projectId: projectId ?? null,
      });
      success++;
    } catch {
      failed++;
    }
  }

  return { success, failed };
}

// ── Background save retry ──────────────────────────────────

interface PendingRetry {
  cardId: string;
  remoteUrl: string;
  imageField: string;
  projectId?: string;
  attempt: number;
  timerId: ReturnType<typeof setTimeout>;
}

const RETRY_DELAYS = [5_000, 15_000, 45_000, 120_000, 300_000];
const _pendingRetries = new Map<string, PendingRetry>();

export function scheduleBackgroundSave(
  cardId: string,
  remoteUrl: string,
  imageField = "imageUrl",
  projectId?: string,
): void {
  if (_pendingRetries.has(cardId)) return;
  enqueueRetry(cardId, remoteUrl, imageField, projectId, 0);
}

function enqueueRetry(
  cardId: string,
  remoteUrl: string,
  imageField: string,
  projectId: string | undefined,
  attempt: number,
): void {
  if (attempt >= RETRY_DELAYS.length) {
    _pendingRetries.delete(cardId);
    console.warn(`[bgSave] ${cardId} 已达最大重试次数，放弃后台保存`);
    return;
  }

  const delay = RETRY_DELAYS[attempt]!;
  console.log(`[bgSave] ${cardId} 将在 ${delay / 1000}s 后进行第 ${attempt + 1} 次重试`);

  const timerId = setTimeout(() => void doRetry(cardId), delay);
  _pendingRetries.set(cardId, { cardId, remoteUrl, imageField, projectId, attempt, timerId });
}

async function doRetry(cardId: string): Promise<void> {
  const entry = _pendingRetries.get(cardId);
  if (!entry) return;

  const { useCardStore } = await import("@/stores/cardStore");
  const { autoSave } = await import("@/lib/autoSave");

  const card = useCardStore.getState().getCard(cardId);
  if (!card) {
    _pendingRetries.delete(cardId);
    return;
  }

  const currentUrl = (card.data as Record<string, unknown>)[entry.imageField] as string | undefined;
  if (!currentUrl || !currentUrl.startsWith("http")) {
    _pendingRetries.delete(cardId);
    return;
  }

  try {
    const result = await saveMedia(entry.remoteUrl, undefined, card.title || undefined, entry.projectId);
    useCardStore.getState().updateCard(cardId, {
      data: { ...card.data, [entry.imageField]: result.localPath },
    });
    autoSave.markDirty(cardId);
    _pendingRetries.delete(cardId);
    console.log(`[bgSave] ${cardId} 后台保存成功`);
  } catch (e) {
    console.warn(`[bgSave] ${cardId} 第 ${entry.attempt + 1} 次重试失败:`, e);
    _pendingRetries.delete(cardId);
    enqueueRetry(cardId, entry.remoteUrl, entry.imageField, entry.projectId, entry.attempt + 1);
  }
}

export function cancelBackgroundSave(cardId: string): void {
  const entry = _pendingRetries.get(cardId);
  if (entry) {
    clearTimeout(entry.timerId);
    _pendingRetries.delete(cardId);
  }
}
