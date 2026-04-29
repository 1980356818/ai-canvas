import { saveMedia, readMediaBase64 } from "@/platform/media.api";
import { isTauri } from "@/platform/runtime";

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
 * Save any image source (data URL, HTTP URL, local path) to local storage.
 * When `projectId` is provided, auto-saved copies are organized into
 * a project-specific subfolder: `{title}_{short_id}/`.
 */
export async function persistImage(
  source: string,
  title?: string,
  projectId?: string,
): Promise<PersistImageResult> {
  if (!isTauri) return { localPath: source };

  const result = await saveMedia(source, undefined, title, projectId);
  return {
    localPath: result.localPath,
    width: result.width,
    height: result.height,
  };
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

/**
 * Convert a stored relative path to a URL that `<img src>` can display.
 * Uses Tauri's asset protocol for zero-copy file loading.
 * Passthrough for data:/http:/blob: URLs.
 */
export function getDisplayUrl(storedPath: string): string {
  if (!storedPath) return "";

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
 * Read a stored image as a base64 data URL, for sending to AI APIs.
 * Only call this when you actually need to send image data over the network.
 */
export async function getBase64ForApi(storedPath: string): Promise<string> {
  if (!storedPath) return "";

  if (storedPath.startsWith("data:")) {
    return storedPath;
  }

  if (isFrontendAssetUrl(storedPath)) {
    return urlToDataUrl(storedPath);
  }

  if (storedPath.startsWith("http://") || storedPath.startsWith("https://")) {
    return storedPath;
  }

  return readMediaBase64(storedPath);
}

function sanitizeFilename(raw: string, maxLen = 80): string {
  return raw
    .replace(/[\x00-\x1f<>:"/\\|?*\n\r\t]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.\s]+|[_.\s]+$/g, "")
    .slice(0, maxLen) || "AI文件";
}

function makeTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 15)
    .replace(/\.$/, "");
}

/**
 * Export an image or video to the user's configured save directory.
 * Saves to `file_auto_save_path/{project_folder}/filename`.
 */
export async function exportFile(
  storedPath: string,
  cardTitle: string,
  projectId?: string,
): Promise<string> {
  if (!isTauri) return storedPath;

  const invoke = await ensureInvoke();
  const ext = storedPath.split(".").pop() || "png";
  const safeName = sanitizeFilename(cardTitle);
  const exportName = `${safeName}_${makeTimestamp()}.${ext}`;

  return invoke<string>("export_file", {
    sourcePath: storedPath,
    exportName,
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

  for (let i = 0; i < items.length; i++) {
    const { storedPath, cardTitle, projectId } = items[i]!;
    try {
      const ext = storedPath.split(".").pop() || "png";
      const safeName = sanitizeFilename(cardTitle);
      const exportName = `${safeName}_${makeTimestamp()}_${i + 1}.${ext}`;

      await invoke<string>("export_file", {
        sourcePath: storedPath,
        exportName,
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
