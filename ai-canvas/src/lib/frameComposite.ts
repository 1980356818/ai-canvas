//! 关键帧合并图 — 用 HTML Canvas 把 N 张帧拼成一张 PNG。
//!
//! 设计原因不用 Rust ffmpeg `tile` 滤镜:
//!   1. 时间戳角标需要绘字,Rust 端要带字体 + imageproc 依赖;Canvas 用浏览器自带字体免税;
//!   2. 已经有 `persistImage(dataURL)` 三级分流(IPC-safe → 落盘 / 大文件 → 分块),
//!      Canvas → dataURL → persistImage 是天然路径,不用新增 Tauri command;
//!   3. 跨平台一致性更好(Rust ffmpeg-sidecar 的 tile 滤镜在不同 OS 行为略有差异)。
//!
//! 内存契约(根治"小间隔抽几百帧在弱机/软件渲染上崩"):
//!   - 帧**不**全量并行解码。早期实现 `Promise.all(frames.map(loadImage))` 会把 N 张
//!     **原分辨率**帧同时解码并一直留到画完,峰值 ≈ N × 帧宽 × 帧高 × 4。0.5s 间隔
//!     抽几百张 1080p/4K → 1~4GB,在没硬件加速(集显/虚拟机/远程桌面回退 SwiftShader
//!     软件渲染)的机器上直接崩 → "失败"。同一视频在 GPU 机上却过 —— 全是这条。
//!   - 现在走「有界并发解码 → 立即画 → 立即释放」(见 `runDecodePool`),且用
//!     `createImageBitmap(blob,{resizeWidth/Height})` **按单格尺寸降采样解码**,峰值
//!     ≈ 并发数 × 单格 × 4,**与帧数 N 解耦**,几百上千帧也恒定。
//!   - 合成画布本身按 `maxEdge=2560` 封顶,不是瓶颈;瓶颈一直是解码surface的总量。

import { getDisplayUrl, persistImage } from "@/lib/media";
import {
  chooseFrameGrid,
  computeCompositeDimensions,
  cellPosition,
  type CompositeOptions,
  type CompositeDimensions,
} from "@/lib/frameLayout";

// ── 类型 ──────────────────────────────────────────────────────────────

export interface FrameInput {
  /** 抽帧落盘后的存储路径(`media/keyframes/<sha>/frame_xxx.jpg`)。 */
  framePath: string;
  /** 视频内的时间戳(秒)。 */
  timestamp: number;
  /** 该帧在视频里的序号(1 起步)。 */
  index: number;
  /** 可选标题,继承自 shot.description / shotTitle。 */
  title?: string;
}

export interface ComposeResult {
  /** 合成图的存储路径(`media/images/xxx.png`)。 */
  imagePath: string;
  /** 合成图整体像素宽。 */
  width: number;
  /** 合成图整体像素高。 */
  height: number;
  /** 排版网格 (cols × rows)。 */
  layout: { cols: number; rows: number };
  /** 每帧在合成图里的归档信息 — 用于后续"一键拆分"还原。 */
  frames: FrameInput[];
}

export interface ComposeFramesArgs {
  /** 待合并的帧列表。按顺序排列(行主序填入网格)。 */
  frames: FrameInput[];
  /** 用于 `persistImage` 落盘归属的项目 ID。 */
  projectId: string;
  /** 落盘时给文件起的可读名前缀,例如 `"关键帧"`。 */
  title?: string;
  /** Canvas 排版可选参数。 */
  options?: CompositeOptions;
}

// ── 图像加载 ──────────────────────────────────────────────────────────

/** 加载一张帧到 HTMLImageElement。失败 reject,由调用方决定是否兜底。
 *
 * `crossOrigin = "anonymous"` 是必须的:帧路径走 `convertFileSrc` 变成
 * `asset://localhost/...`,跟 webview origin 不同源;若 `<img>` 没声明 CORS,
 * 后面 `drawImage` 一画 canvas 就被 tainted,`canvas.toDataURL` 直接抛
 * `SecurityError: Tainted canvases may not be exported`。Tauri v2 的 asset
 * 协议默认回 `Access-Control-Allow-Origin: *`,加了 anonymous 不会触发 onerror。 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`加载帧失败: ${src}`));
    img.src = src;
  });
}

/** mm:ss 时间格式(< 1h);≥ 1h 才走 hh:mm:ss。 */
function formatStamp(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// ── Canvas 绘制 ──────────────────────────────────────────────────────

/** 在单元格内按"contain"模式绘制图像 — 保比例,letterbox 白色。
 *  接受 HTMLImageElement(兜底全分辨率)或 ImageBitmap(降采样解码,主路径)。 */
function drawContain(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | ImageBitmap,
  cellX: number,
  cellY: number,
  cellW: number,
  cellH: number,
): void {
  // ImageBitmap 无 naturalWidth,用 width/height;HTMLImageElement 优先 naturalWidth。
  const iw = (img as HTMLImageElement).naturalWidth || img.width;
  const ih = (img as HTMLImageElement).naturalHeight || img.height;
  if (iw <= 0 || ih <= 0) return;

  const scale = Math.min(cellW / iw, cellH / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = cellX + (cellW - dw) / 2;
  const dy = cellY + (cellH - dh) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);
}

/** 左上角时间戳小角标 — 半透明深色背景 + 白字。 */
function drawTimestampBadge(
  ctx: CanvasRenderingContext2D,
  text: string,
  cellX: number,
  cellY: number,
  cellW: number,
): void {
  // 字号按单格宽自适应,但限定上下限避免巨图字过大 / 小图字看不清。
  const fontSize = Math.max(11, Math.min(22, Math.round(cellW * 0.05)));
  const padX = Math.round(fontSize * 0.6);
  const padY = Math.round(fontSize * 0.3);
  const offset = Math.max(6, Math.round(fontSize * 0.5));

  ctx.font = `600 ${fontSize}px ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace`;
  ctx.textBaseline = "top";

  const m = ctx.measureText(text);
  const bgW = m.width + padX * 2;
  const bgH = fontSize + padY * 2;

  ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
  ctx.fillRect(cellX + offset, cellY + offset, bgW, bgH);

  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, cellX + offset + padX, cellY + offset + padY);
}

// ── 有界并发解码(内存根治核心) ──────────────────────────────────────

/** 同时在飞的解码数上限。峰值内存 ≈ 该值 × 单格像素 × 4,与帧数 N 解耦。
 *  4 在弱机上也只占几 MB(降采样后),又能让"解码↔画"流水重叠不拖慢。 */
const DECODE_CONCURRENCY = 4;

/** 把 N 个任务用固定大小的 worker 池串起来跑,任意时刻至多 `concurrency` 个在飞。
 *  worker 内部 await 解码,画布绘制是同步的(JS 单线程,不会撕裂 ctx 状态)。
 *  导出仅供单测锁"并发上限与帧数解耦"这条不变量。 */
export async function runDecodePool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const n = items.length;
  if (n === 0) return;
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(1, concurrency), n) },
    async () => {
      // `cursor++` 读改之间无 await,单线程下原子,worker 间不会抢到同一个 index。
      for (let i = cursor++; i < n; i = cursor++) {
        await worker(items[i]!, i);
      }
    },
  );
  await Promise.all(runners);
}

/** 源 aspect(W/H)按 contain 塞进 box 后的目标像素。用它做"按需降采样解码"的尺寸。
 *  导出供单测。 */
export function containSize(
  aspect: number,
  boxW: number,
  boxH: number,
): { w: number; h: number } {
  let w = boxW;
  let h = boxW / aspect;
  if (h > boxH) {
    h = boxH;
    w = boxH * aspect;
  }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

/**
 * 解码一张帧并**尽量按 target 尺寸降采样**,避免把原分辨率位图塞进内存。
 *
 * 主路径:`fetch → blob → createImageBitmap(blob,{resizeWidth/Height})` —— 直接解到
 * 单格大小,峰值=单格;返回的 ImageBitmap 可 `close()` 确定性释放。
 * 兜底:某些 webview 不支持 createImageBitmap 的 resize 选项 / fetch asset 协议失败时,
 * 退回全分辨率 `<img>`(仍被并发池约束,峰值=并发数×原帧,远好于 N×原帧)。
 * 全部失败返回 null,由调用方画占位格。
 */
async function decodeFrameDownscaled(
  src: string,
  targetW: number,
  targetH: number,
): Promise<HTMLImageElement | ImageBitmap | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const resp = await fetch(src);
      if (resp.ok) {
        const blob = await resp.blob();
        return await createImageBitmap(blob, {
          resizeWidth: Math.max(1, Math.round(targetW)),
          resizeHeight: Math.max(1, Math.round(targetH)),
          resizeQuality: "high",
        });
      }
    } catch {
      // 落到 <img> 兜底
    }
  }
  try {
    return await loadImage(src);
  } catch {
    return null;
  }
}

/** 探单格 aspect:帧同源同分辨率,取前几张里第一张能解的即可,全失败兜底 16:9。
 *  只为拿宽高比,单张全分辨率解码可接受(随即丢弃 GC)。 */
async function probeCellAspect(frames: FrameInput[]): Promise<number> {
  const tries = Math.min(3, frames.length);
  for (let i = 0; i < tries; i++) {
    const img = await loadImage(getDisplayUrl(frames[i]!.framePath)).catch(
      () => null,
    );
    if (img) {
      return (img.naturalWidth || 16) / (img.naturalHeight || 9);
    }
  }
  return 16 / 9;
}

// ── 主入口 ────────────────────────────────────────────────────────────

/**
 * 把 N 张帧拼成一张白底 PNG,落盘后返回路径 + 元信息。
 *
 * - 单格 aspect 取**第一张**帧的真实比例(N 张视频帧理论上 aspect 一致;
 *   不一致时其余帧按 contain 模式塞进同尺寸单格)。
 * - 空白格(单数边角)自动留白 — Canvas 已被填成白底,无需额外绘制。
 * - 时间戳角标在左上角,16px 起步、跟随单格宽度缩放。
 */
export async function composeFrameGrid(
  args: ComposeFramesArgs,
): Promise<ComposeResult> {
  const { frames, projectId, title, options } = args;
  if (frames.length === 0) throw new Error("合成失败:帧列表为空");

  // 1. 确定单格 aspect(只解前几张里任意一张,不全量解码)。
  const cellAspect = await probeCellAspect(frames);

  // 2. 算排版 + 像素尺寸。
  const layout = chooseFrameGrid(frames.length);
  const dims: CompositeDimensions = computeCompositeDimensions(
    layout,
    cellAspect,
    options,
  );

  // 3. 创建 canvas + 白底。
  const canvas = document.createElement("canvas");
  canvas.width = dims.totalWidth;
  canvas.height = dims.totalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建 Canvas 2D context");

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, dims.totalWidth, dims.totalHeight);

  // 4. 单格 contain 后的目标像素 —— 解码时直接降到这个尺寸,峰值内存与帧数解耦。
  //    帧同源同分辨率,fit 对每帧一致。
  const fit = containSize(cellAspect, dims.cellWidth, dims.cellHeight);

  // 5. 有界并发逐帧:降采样解码 → 立即画 → 立即释放。峰值 ≈ 并发数 × 单格,
  //    无论 0.5s 抽几百帧都恒定 —— 弱机/软件渲染不再 OOM(见文件顶部内存契约)。
  await runDecodePool(frames, DECODE_CONCURRENCY, async (frame, i) => {
    const { x, y } = cellPosition(i, layout, dims);

    let drawn = false;
    try {
      const bmp = await decodeFrameDownscaled(
        getDisplayUrl(frame.framePath),
        fit.w,
        fit.h,
      );
      if (bmp) {
        drawContain(ctx, bmp, x, y, dims.cellWidth, dims.cellHeight);
        // ImageBitmap 立即 close() 确定性释放显存/内存;<img> 兜底交给 GC。
        if (typeof (bmp as ImageBitmap).close === "function") {
          (bmp as ImageBitmap).close();
        }
        drawn = true;
      }
    } catch (e) {
      console.warn("[frameComposite] 跳过加载失败的帧:", frame.framePath, e);
    }

    if (!drawn) {
      // 加载失败:格内画浅灰 placeholder + "加载失败"文字,便于排查
      ctx.fillStyle = "#f3f4f6";
      ctx.fillRect(x, y, dims.cellWidth, dims.cellHeight);
      ctx.fillStyle = "#9ca3af";
      ctx.font = `500 16px ui-sans-serif, system-ui`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.fillText("帧加载失败", x + dims.cellWidth / 2, y + dims.cellHeight / 2);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    }

    drawTimestampBadge(ctx, formatStamp(frame.timestamp), x, y, dims.cellWidth);
  });

  // 6. 导出为 PNG dataURL → 走 persistImage 落盘(自动分流 IPC 安全 / 分块上传)。
  const dataUrl = canvas.toDataURL("image/png");
  const { localPath } = await persistImage(
    dataUrl,
    title ?? "关键帧合成",
    projectId,
  );

  return {
    imagePath: localPath,
    width: dims.totalWidth,
    height: dims.totalHeight,
    layout,
    frames,
  };
}
