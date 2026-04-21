import { getDisplayUrl } from "@/lib/media";
import { readMediaBase64 } from "@/platform";

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function isDirectUrl(url: string): boolean {
  return (
    url.startsWith("data:") ||
    url.startsWith("blob:") ||
    url.startsWith("http://") ||
    url.startsWith("https://")
  );
}

async function loadImageBitmap(imageUrl: string): Promise<ImageBitmap> {
  let fetchUrl: string;

  if (isDirectUrl(imageUrl)) {
    fetchUrl = imageUrl;
  } else {
    try {
      const dataUrl = await readMediaBase64(imageUrl);
      if (dataUrl) {
        fetchUrl = dataUrl;
      } else {
        fetchUrl = getDisplayUrl(imageUrl);
      }
    } catch {
      fetchUrl = getDisplayUrl(imageUrl);
    }
  }

  const resp = await fetch(fetchUrl);
  if (!resp.ok) throw new Error(`图片加载失败 (${resp.status})`);
  const blob = await resp.blob();
  return createImageBitmap(blob);
}

function renderToDataUrl(
  bmp: ImageBitmap,
  sx: number, sy: number, sw: number, sh: number,
  outW: number, outH: number,
): Promise<string> | string {
  if (typeof OffscreenCanvas !== "undefined") {
    const oc = new OffscreenCanvas(outW, outH);
    const ctx = oc.getContext("2d")!;
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, outW, outH);
    bmp.close();
    return oc.convertToBlob({ type: "image/png" }).then((b) => blobToDataUrl(b));
  }

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, outW, outH);
  bmp.close();
  return canvas.toDataURL("image/png");
}

/** Grid-based crop: extract one cell from an NxN grid. */
export async function cropImageCell(
  imageUrl: string,
  row: number,
  col: number,
  gridSize: number,
): Promise<{ dataUrl: string; cellW: number; cellH: number }> {
  const bmp = await loadImageBitmap(imageUrl);
  const cellW = Math.floor(bmp.width / gridSize);
  const cellH = Math.floor(bmp.height / gridSize);
  const dataUrl = await renderToDataUrl(
    bmp, col * cellW, row * cellH, cellW, cellH, cellW, cellH,
  );
  return { dataUrl, cellW, cellH };
}

/** Free-form crop: extract a region defined by relative 0-1 coordinates. */
export async function cropImageRegion(
  imageUrl: string,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): Promise<{ dataUrl: string; cropW: number; cropH: number }> {
  const bmp = await loadImageBitmap(imageUrl);
  const cropW = Math.max(1, Math.round(rw * bmp.width));
  const cropH = Math.max(1, Math.round(rh * bmp.height));
  const sx = Math.round(rx * bmp.width);
  const sy = Math.round(ry * bmp.height);
  const dataUrl = await renderToDataUrl(bmp, sx, sy, cropW, cropH, cropW, cropH);
  return { dataUrl, cropW, cropH };
}
