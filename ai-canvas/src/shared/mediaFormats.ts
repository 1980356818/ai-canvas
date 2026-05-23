/**
 * 媒体格式白名单 —— 项目内唯一来源。
 *
 * 凡是"文件能不能作为图/视频/音频卡片被拖入"的判定都必须走这里。
 * 三条 RegExp + 三个 Set 同源派生，前端 dnd / Tauri 文件过滤器 / 内部校验
 * 都从这里 import，不允许在别处再写一份。
 *
 * Rust 端 (`src-tauri/src/commands/ai.rs::detect_extension` /
 * `is_supported_media_ext`) 必须与本表保持同步 —— 那边的 MIME →
 * 扩展名映射决定了 `save_media` 把 dataURL 落盘时取什么后缀，错配
 * 会把视频写成 `.png` 之类。
 *
 * 改动这里时记得：
 *   1. 同步更新 Rust 那边的 mime/ext 表
 *   2. VideoPreview 的 `<video>` 兜底 onError 不依赖白名单（任何被
 *      白名单放行但 WebView 实际解不动的编码，靠运行时 onError 兜底）
 */

export const IMAGE_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif",
  "tif", "tiff", "heic", "heif",
] as const;

export const VIDEO_EXTENSIONS = [
  "mp4", "webm", "mov", "m4v", "avi", "mkv",
] as const;

export const AUDIO_EXTENSIONS = [
  "wav", "mp3",
] as const;

export const IMAGE_EXTENSIONS_REGEX =
  /\.(png|jpe?g|gif|webp|bmp|svg|avif|tiff?|heic|heif)$/i;

export const VIDEO_EXTENSIONS_REGEX =
  /\.(mp4|webm|mov|m4v|avi|mkv)$/i;

export const AUDIO_EXTENSIONS_REGEX =
  /\.(wav|mp3)$/i;

/** 任意支持的媒体扩展名，合并三类。给 Tauri 原生过滤器用。 */
export const ANY_MEDIA_EXTENSIONS_REGEX =
  /\.(png|jpe?g|gif|webp|bmp|svg|avif|tiff?|heic|heif|mp4|webm|mov|m4v|avi|mkv|wav|mp3)$/i;

export function isImagePath(p: string): boolean {
  return IMAGE_EXTENSIONS_REGEX.test(p);
}

export function isVideoPath(p: string): boolean {
  return VIDEO_EXTENSIONS_REGEX.test(p);
}

export function isAudioPath(p: string): boolean {
  return AUDIO_EXTENSIONS_REGEX.test(p);
}
