//! 关键帧合并图的排版规约。
//!
//! 用户期望:
//!   - 4 张 → 2×2;6 张 → 3×2;5 张 → 3×2(第二行 2 张,1 个白格);
//!   - 单数补白色填充;排版"好看"(尽量正方形/横向,空白格少)。
//!
//! 选 cols 策略:取 ⌈√n⌉ 与 ⌈√n⌉+1 中空白格数更少的一种。打平时优先
//! 更接近正方形的(cols 较小)。短序列 (n ≤ 3) 走单行,避免无意义白格。

/** 选取 n 张帧最舒服的网格。返回的 cols × rows 一定 ≥ n,差额=空白格。 */
export function chooseFrameGrid(n: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n === 3) return { cols: 3, rows: 1 };

  const colsA = Math.ceil(Math.sqrt(n));
  const rowsA = Math.ceil(n / colsA);
  const wasteA = colsA * rowsA - n;

  const colsB = colsA + 1;
  const rowsB = Math.ceil(n / colsB);
  const wasteB = colsB * rowsB - n;

  return wasteB < wasteA
    ? { cols: colsB, rows: rowsB }
    : { cols: colsA, rows: rowsA };
}

export interface CompositeDimensions {
  /** 单元格像素宽。 */
  cellWidth: number;
  /** 单元格像素高。 */
  cellHeight: number;
  /** 整图像素宽 = padding*2 + cols*cellW + (cols-1)*gap。 */
  totalWidth: number;
  /** 整图像素高 = padding*2 + rows*cellH + (rows-1)*gap。 */
  totalHeight: number;
  /** 单元格之间的白色间隙。 */
  gap: number;
  /** 整图外缘留白。 */
  padding: number;
}

export interface CompositeOptions {
  /** 合成图最长边像素上限。默认 2560。 */
  maxEdge?: number;
  /** 格间空白(白色)。默认 8px。 */
  gap?: number;
  /** 外缘留白。默认 = gap。 */
  padding?: number;
}

/**
 * 给定排版 + 单格 aspect(W/H),计算合成图整体像素尺寸。
 *
 * 思路:让最长边正好打到 `maxEdge`。设 cellH = h:
 *   - cellW = h * cellAspect
 *   - totalW(h) = cols * h * cellAspect + (cols-1) * gap + 2 * padding
 *   - totalH(h) = rows * h + (rows-1) * gap + 2 * padding
 *
 * 取 h 的两个候选(让 totalW 或 totalH 命中 maxEdge),用较小者,从而保证
 * max(totalW, totalH) ≤ maxEdge 且其中之一恰好 = maxEdge。
 */
export function computeCompositeDimensions(
  layout: { cols: number; rows: number },
  cellAspect: number,
  options: CompositeOptions = {},
): CompositeDimensions {
  const maxEdge = options.maxEdge ?? 2560;
  const gap = options.gap ?? 8;
  const padding = options.padding ?? gap;
  const { cols, rows } = layout;

  const hFromW = (maxEdge - (cols - 1) * gap - 2 * padding) / (cols * cellAspect);
  const hFromH = (maxEdge - (rows - 1) * gap - 2 * padding) / rows;

  const cellHeight = Math.max(40, Math.floor(Math.min(hFromW, hFromH)));
  const cellWidth = Math.max(40, Math.round(cellHeight * cellAspect));

  const totalWidth = cols * cellWidth + (cols - 1) * gap + 2 * padding;
  const totalHeight = rows * cellHeight + (rows - 1) * gap + 2 * padding;

  return { cellWidth, cellHeight, totalWidth, totalHeight, gap, padding };
}

/** 单元格在合成图里的像素位置 (左上角)。索引按行主序,从 0 起。 */
export function cellPosition(
  index: number,
  layout: { cols: number; rows: number },
  dims: CompositeDimensions,
): { x: number; y: number } {
  const row = Math.floor(index / layout.cols);
  const col = index % layout.cols;
  return {
    x: dims.padding + col * (dims.cellWidth + dims.gap),
    y: dims.padding + row * (dims.cellHeight + dims.gap),
  };
}
