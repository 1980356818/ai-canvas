const HEIC_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);
const HEIC_EXT_RE = /\.(heic|heif)$/i;

export function isHeicFile(file: File): boolean {
  return HEIC_TYPES.has(file.type) || HEIC_EXT_RE.test(file.name);
}

export function isHeicPath(path: string): boolean {
  return HEIC_EXT_RE.test(path);
}

/**
 * Convert a HEIC/HEIF file to JPEG. Returns the original file unchanged
 * if it is not HEIC.  Uses dynamic import so the ~200 KB WASM decoder
 * is only loaded when actually needed.
 */
export async function ensureDisplayableImage(file: File): Promise<File> {
  if (!isHeicFile(file)) return file;

  const heic2any = (await import("heic2any")).default;
  const blob = await heic2any({
    blob: file,
    toType: "image/jpeg",
    quality: 0.92,
  });
  const result = Array.isArray(blob) ? blob[0]! : blob;
  const newName = file.name.replace(HEIC_EXT_RE, ".jpg");
  return new File([result], newName, { type: "image/jpeg" });
}

/**
 * Convert a HEIC file path (Tauri native drop) to a JPEG data URL.
 * Reads the file via Tauri backend, decodes with heic2any, returns
 * a `data:image/jpeg;base64,...` string ready for persistImage.
 * For non-HEIC paths, returns the original path unchanged.
 */
export async function convertHeicPath(filePath: string): Promise<string> {
  if (!isHeicPath(filePath)) return filePath;

  const { readMediaBase64 } = await import("@/platform");
  const dataUrl = await readMediaBase64(filePath);

  const resp = await fetch(dataUrl);
  const blob = await resp.blob();

  const heic2any = (await import("heic2any")).default;
  const converted = await heic2any({
    blob,
    toType: "image/jpeg",
    quality: 0.92,
  });
  const result = Array.isArray(converted) ? converted[0]! : converted;

  return new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(result as Blob);
  });
}
