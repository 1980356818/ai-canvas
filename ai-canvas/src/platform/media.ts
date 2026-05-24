// ai-canvas 媒体送上游 AI API 的**唯一**入口。
//
// 历史:之前各业务模块直接调 `lib/media.ts::getBase64ForApi(url)`,该函数在
// Tauri 模式下返回 `local://` 占位符,Rust 端再 `inline_local_files` 展开为
// base64 塞进 JSON。这条链路有 4 道墙:
//   - WebView2 IPC 3MB 单次
//   - Rust ipc_guard 64MB 累计  ← 用户撞过
//   - nginx 100MB                ← 用户撞过
//   - MySQL request_params       ← 2026-04 P0 事故
//
// 根治方案:**二进制不进 JSON**。所有送上游的引用必须先经 mediaToApiRef
// 转成 HTTP URL,JSON body 只放 URL。详见
// [docs/media-upload-refactor.md](../../docs/media-upload-refactor.md)。
//
// **规范**:任何要送给 generateImage / generateVideo / chat / agent 等
// 上游 API 的本地媒体引用,都走 mediaToApiRef,不允许直接调 getBase64ForApi
// 或自行构造 base64 dataURL 塞进请求体。eslint 规则会拦截误用。

import { isTauri, ensureTauriAPIs, getInvoke } from "./runtime";
import { buildProxyUrl, getProviderAuthHeaders } from "./storage";

/**
 * Rust 端 `upload_to_server` command 返回结构。跟
 * `src-tauri/src/commands/upload_remote.rs::UploadResult` 对齐。
 */
export interface UploadResult {
  url: string;
  sha256: string;
  contentType: string;
  size: number;
  /** true = 命中本地或服务端缓存, 没有实际产生上传 HTTP */
  cached: boolean;
}

/**
 * 服务端 `R<T>` 信封, 跟 jijing-common-core 的 `R.java` 对齐。
 */
interface ServerEnvelope<T> {
  code: number;
  message?: string;
  data?: T;
}

interface ServerFileUploadResponse {
  id: string;
  url: string;
  sha256: string;
  contentType: string;
  size: number;
  purpose: string;
  cached?: boolean;
}

export interface MediaToApiRefOptions {
  /** 哪个 provider 的 base_url 走上传 (默认 jijing) */
  provider?: string;
  /**
   * 预热模式 —— 用户拖入/粘贴后台静默上传时设 true,
   * Rust 端占独立 PREWARM_SEMAPHORE(2), 不挤占主路径 MAIN_SEMAPHORE(4)。
   * 主动触发 (点生成 / 送 ref 图) 走 false (默认)。
   *
   * 跟主路径**共享 in-flight 单飞**:预热和主路径撞同一 sha256 时,
   * 后到的 follower 直接 await 先到的 broadcast, 不重复发 HTTP。
   */
  prewarm?: boolean;
}

/**
 * 把任意本地媒体引用转成上游 AI API 可消费的 HTTP URL。
 *
 * 接受输入:
 * - `http://` / `https://` URL — 原样返回 (已是远端)
 * - `local://<rel>` Tauri 占位符 — invoke Rust 上传
 * - `data:<mime>;base64,...` dataURL — Web 模式直接 multipart 上传
 * - 相对存储路径 / Vite 前端 asset / blob: URL — 内部 fetch 转 Blob 再上传
 *
 * 永远返回 HTTPS URL。失败抛 Error, 调用方按错误信息决定 UX (展示 toast /
 * 切换 provider / 等)。
 *
 * @throws {Error} 上传失败 (鉴权 / 体积 / 网络 / 服务端 5xx)
 */
export async function mediaToApiRef(
  input: string,
  opts?: MediaToApiRefOptions
): Promise<string> {
  if (!input) return "";

  // 已是远端 URL — 原样直传, 不浪费上传带宽
  if (input.startsWith("http://") || input.startsWith("https://")) {
    return input;
  }

  const provider = opts?.provider ?? "jijing";
  const prewarm = opts?.prewarm ?? false;

  if (isTauri) {
    return uploadViaTauri(input, provider, prewarm);
  }

  return uploadViaFetch(input, provider);
}

/**
 * Tauri 模式: Rust 端走 `upload_to_server` command, 自带 sha256 流式 + sqlite
 * 缓存 + in-flight 单飞 + 双 semaphore (main / prewarm) 分桶。
 */
async function uploadViaTauri(input: string, provider: string, prewarm: boolean): Promise<string> {
  await ensureTauriAPIs();
  const result = await getInvoke()<UploadResult>("upload_to_server", {
    path: input,
    provider,
    prewarm,
  });
  return result.url;
}

/**
 * Web 模式: 把 dataURL / blob: / 前端 asset / 相对路径都先 fetch 成 Blob,
 * 再 multipart POST 到服务端。Web 模式没有 sqlite 缓存, 重复使用同一张图会
 * 重传 — 但 Web 模式通常只用于开发预览, 实际用户都在 Tauri 桌面端。
 */
async function uploadViaFetch(input: string, provider: string): Promise<string> {
  const blob = await resolveToBlob(input);
  const filename = guessFilename(input, blob.type);

  const form = new FormData();
  form.append("file", blob, filename);
  form.append("purpose", "media-input");

  const url = buildProxyUrl("/v1/files/upload", provider);
  // 不要手动设 Content-Type, 浏览器会自动加 boundary
  const headers: Record<string, string> = { ...getProviderAuthHeaders(provider) };

  const resp = await fetch(url, { method: "POST", headers, body: form });
  const bodyText = await resp.text();

  if (!resp.ok) {
    const msg = extractServerErrorMessage(bodyText) ?? `HTTP ${resp.status}`;
    throw new Error(`上传失败: ${msg}`);
  }

  let envelope: ServerEnvelope<ServerFileUploadResponse>;
  try {
    envelope = JSON.parse(bodyText);
  } catch {
    throw new Error(`上传响应解析失败: ${bodyText.slice(0, 200)}`);
  }
  if (envelope.code !== 200 || !envelope.data?.url) {
    throw new Error(`上传失败: ${envelope.message ?? `code=${envelope.code}`}`);
  }
  return envelope.data.url;
}

async function resolveToBlob(input: string): Promise<Blob> {
  if (input.startsWith("data:")) {
    return dataUrlToBlob(input);
  }
  // blob: / 前端 asset / 相对路径 都能 fetch
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
 * 4xx/5xx 时尝试从服务端 `R<T>` 信封拿 message,
 * 拿不到就返 null 让调用方走兜底 HTTP code。
 */
function extractServerErrorMessage(bodyText: string): string | null {
  if (!bodyText) return null;
  try {
    const obj = JSON.parse(bodyText);
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error?.message === "string") return obj.error.message;
  } catch {
    /* fallthrough */
  }
  return null;
}
