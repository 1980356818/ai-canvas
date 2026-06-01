//! 关键帧合并图 — 用 HTML Canvas 把 N 张帧拼成一张 PNG。
//!
//! 设计原因不用 Rust ffmpeg `tile` 滤镜:
//!   1. 时间戳角标需要绘字,Rust 端要带字体 + imageproc 依赖;Canvas 用浏览器自带字体免税;
//!   2. 已经有 `persistImage(dataURL)` 三级分流(IPC-safe → 落盘 / 大文件 → 分块),
//!      Canvas → dataURL → persistImage 是天然路径,不用新增 Tauri command;
//!   3. 跨平台一致性更好(Rust ffmpeg-sidecar 的 tile 滤镜在不同 OS 行为略有差异)。
//!
//! 成本是: Canvas 在 webview 里要解码 N 张 JPEG,峰值内存 ≈ Σ cellW*cellH*4 字节。
//! 已经按 `maxEdge=2560` 封顶,6 张 3×2 → 单格 ≈ 850×478 → 总解码 ≈ 10MB,安全。

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

/** 在单元格内按"contain"模式绘制图像 — 保比例,letterbox 白色。 */
function drawContain(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  cellX: number,
  cellY: number,
  cellW: number,
  cellH: number,
): void {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
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

  // 1. 解码所有帧(并行),失败的帧记下,但不阻塞其他帧 — 单格白即可。
  const images = await Promise.all(
    frames.map((f) =>
      loadImage(getDisplayUrl(f.framePath)).catch((e) => {
        console.warn("[frameComposite] 跳过加载失败的帧:", f.framePath, e);
        return null;
      }),
    ),
  );

  // 2. 确定单格 aspect:用第一张成功加载的帧;全失败兜底 16:9。
  const firstOk = images.find((im): im is HTMLImageElement => !!im);
  const cellAspect = firstOk
    ? (firstOk.naturalWidth || 16) / (firstOk.naturalHeight || 9)
    : 16 / 9;

  // 3. 算排版 + 像素尺寸。
  const layout = chooseFrameGrid(frames.length);
  const dims: CompositeDimensions = computeCompositeDimensions(
    layout,
    cellAspect,
    options,
  );

  // 4. 创建 canvas + 白底。
  const canvas = document.createElement("canvas");
  canvas.width = dims.totalWidth;
  canvas.height = dims.totalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建 Canvas 2D context");

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, dims.totalWidth, dims.totalHeight);

  // 5. 逐帧画 + 时间戳角标。
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const img = images[i];
    const { x, y } = cellPosition(i, layout, dims);

    if (img) {
      drawContain(ctx, img, x, y, dims.cellWidth, dims.cellHeight);
    } else {
      // 加载失败:格内画浅灰 placeholder + "加载失败"文字,便于排查
      ctx.fillStyle = "#f3f4f6";
      ctx.fillRect(x, y, dims.cellWidth, dims.cellHeight);
      ctx.fillStyle = "#9ca3af";
      ctx.font = `500 16px ui-sans-serif, system-ui`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.fillText(
        "帧加载失败",
        x + dims.cellWidth / 2,
        y + dims.cellHeight / 2,
      );
      ctx.textAlign = "start";
    }

    drawTimestampBadge(ctx, formatStamp(frame.timestamp), x, y, dims.cellWidth);
  }

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
