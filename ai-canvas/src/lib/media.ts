import { saveMedia, readMediaBase64, isTauri } from "./tauri";

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
 * Returns the relative path and, when available, the detected image dimensions.
 */
export async function persistImage(
  source: string,
  title?: string,
): Promise<PersistImageResult> {
  if (!isTauri) return { localPath: source };

  const result = await saveMedia(source, undefined, title);
  return {
    localPath: result.localPath,
    width: result.width,
    height: result.height,
  };
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
    storedPath.startsWith("data:")
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
  if (
    storedPath.startsWith("data:") ||
    storedPath.startsWith("http://") ||
    storedPath.startsWith("https://")
  ) {
    return storedPath;
  }

  return readMediaBase64(storedPath);
}

/**
 * Export an image to the user's configured export directory.
 * Returns the absolute path of the exported file.
 */
export async function exportImage(
  storedPath: string,
  cardTitle: string,
): Promise<string> {
  if (!isTauri) return storedPath;

  const invoke = await ensureInvoke();
  const ext = storedPath.split(".").pop() || "png";
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 15);
  const safeName = (cardTitle || "AI图片").replace(/[<>:"/\\|?*]/g, "_");
  const exportName = `${safeName}_${timestamp}.${ext}`;

  return invoke<string>("export_image", {
    sourcePath: storedPath,
    exportName,
  });
}

/**
 * Open the system file explorer and highlight the given file.
 */
export async function revealInExplorer(storedPath: string): Promise<void> {
  if (!isTauri) return;
  const invoke = await ensureInvoke();
  await invoke("open_in_explorer", { path: storedPath });
}
