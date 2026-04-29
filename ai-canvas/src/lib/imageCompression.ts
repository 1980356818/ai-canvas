/**
 * 图片压缩 —— 仅服务于"送往 AI 服务前"的最后一道工序。
 *
 * 设计原则：
 * - 纯工具函数，无 UI / store 依赖
 * - 输入是 base64 data URL，输出仍是 base64 data URL
 * - 任何失败都回退到原图，不阻塞业务
 * - 不处理 http(s):// 等远程地址（让后端直接拉取）
 *
 * 调用方应保证只在 provider 出口（如 OpenAICompatProvider.generateImage）
 * 调用一次，避免在显示链路上误压缩。
 */

const DEFAULT_MAX_DIM = 2048;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_JPEG_QUALITY = 0.85;
const FALLBACK_JPEG_QUALITY = 0.7;

export interface CompressOptions {
  /** 长边像素上限，超过则等比缩放。默认 2048 */
  maxDim?: number;
  /** 解码后字节数上限（不是 base64 字符串长度）。默认 4MB */
  maxBytes?: number;
  /** JPEG 输出质量。默认 0.85 */
  jpegQuality?: number;
  /**
   * 强制输出 JPEG（丢失透明通道）。
   *
   * 用于必须把图压缩到固定大小才能安全传输的场景，例如：
   * 把 dataUrl 通过 Tauri IPC 送给 Rust 落盘时，过大 payload 会
   * 拉断 WebView2 IPC 通道。透明 PNG 没法靠 quality 压，必须强制 JPEG。
   */
  forceJpeg?: boolean;
}

interface DecodedDataUrl {
  mime: string;
  binarySize: number;
}

function parseDataUrl(dataUrl: string): DecodedDataUrl | null {
  const m = dataUrl.match(/^data:([^;,]+)(?:;base64)?,(.*)$/i);
  if (!m) return null;
  const mime = m[1] ?? "";
  const payload = m[2] ?? "";
  const isBase64 = /;base64,/i.test(dataUrl);
  const binarySize = isBase64
    ? Math.floor((payload.length * 3) / 4) - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0)
    : payload.length;
  return { mime, binarySize };
}

async function decodeImage(dataUrl: string): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    const blob = await (await fetch(dataUrl)).blob();
    try {
      return await createImageBitmap(blob);
    } catch {
      // fall through to <img>
    }
  }

  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = dataUrl;
  });
}

function getImageSize(img: ImageBitmap | HTMLImageElement): { width: number; height: number } {
  if (img instanceof HTMLImageElement) {
    return { width: img.naturalWidth, height: img.naturalHeight };
  }
  return { width: img.width, height: img.height };
}

interface CanvasLike {
  getContext(id: "2d"): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  toBlob?: (cb: BlobCallback, type?: string, quality?: number) => void;
  convertToBlob?: (opts?: { type?: string; quality?: number }) => Promise<Blob>;
}

function createCanvas(width: number, height: number): CanvasLike {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

async function canvasToBlob(canvas: CanvasLike, type: string, quality: number): Promise<Blob> {
  if (canvas.convertToBlob) {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise<Blob>((resolve, reject) => {
    if (!canvas.toBlob) {
      reject(new Error("canvas 不支持 toBlob"));
      return;
    }
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob 返回 null"))),
      type,
      quality,
    );
  });
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("读取 Blob 失败"));
    r.readAsDataURL(blob);
  });
}

/**
 * 探测图像在指定坐标是否含 alpha < 255 的像素。
 * 仅在 mime 看起来"可能含透明"时才调用，避免无谓开销。
 */
function hasAlpha(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
): boolean {
  // 抽样检测：图大时全图扫描太慢，按格子取样
  const stepX = Math.max(1, Math.floor(width / 32));
  const stepY = Math.max(1, Math.floor(height / 32));
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const px = ctx.getImageData(x, y, 1, 1).data;
      if (px[3] !== undefined && px[3] < 255) return true;
    }
  }
  return false;
}

function maybeTransparent(mime: string): boolean {
  const m = mime.toLowerCase();
  return m === "image/png" || m === "image/webp" || m === "image/gif";
}

/**
 * 将（可能过大的）base64 图片压缩到 API 可接受的大小。
 *
 * - 输入不是 data URL：原样返回
 * - 尺寸/字节都在阈值内：原样返回（不重编码，避免无谓损失）
 * - 否则等比缩放至长边 ≤ maxDim，按透明度选择 JPEG/PNG
 * - 压缩后仍超过 maxBytes：再降一档质量重试一次
 * - 任何异常：回退原图
 */
export async function compressDataUrlForApi(
  dataUrl: string,
  opts?: CompressOptions,
): Promise<string> {
  if (!dataUrl.startsWith("data:")) return dataUrl;

  const maxDim = opts?.maxDim ?? DEFAULT_MAX_DIM;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const jpegQuality = opts?.jpegQuality ?? DEFAULT_JPEG_QUALITY;
  const forceJpeg = !!opts?.forceJpeg;

  const meta = parseDataUrl(dataUrl);
  if (!meta) return dataUrl;

  try {
    const img = await decodeImage(dataUrl);
    const { width, height } = getImageSize(img);
    if (!width || !height) return dataUrl;

    const longEdge = Math.max(width, height);
    const needsResize = longEdge > maxDim;
    const needsRecompress = meta.binarySize > maxBytes;
    if (!needsResize && !needsRecompress && !forceJpeg) {
      return dataUrl;
    }

    const scale = needsResize ? maxDim / longEdge : 1;
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    const canvas = createCanvas(targetW, targetH);
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(img as CanvasImageSource, 0, 0, targetW, targetH);

    const transparent = !forceJpeg
      && maybeTransparent(meta.mime)
      && hasAlpha(ctx, targetW, targetH);
    const outType = transparent ? "image/png" : "image/jpeg";

    let blob = await canvasToBlob(canvas, outType, jpegQuality);
    if (!transparent && blob.size > maxBytes) {
      blob = await canvasToBlob(canvas, "image/jpeg", FALLBACK_JPEG_QUALITY);
    }

    const out = await blobToDataUrl(blob);

    if (img instanceof ImageBitmap) img.close();

    // 强制 JPEG 模式下哪怕输出更大也要输出（调用方就是为了"必须压"才传 forceJpeg）
    if (!forceJpeg && out.length >= dataUrl.length) {
      return dataUrl;
    }
    return out;
  } catch (e) {
    console.warn("[imageCompression] 压缩失败，使用原图:", e);
    return dataUrl;
  }
}
