import type { CanvasCard, CardGroup, Connection, Viewport } from "@/types";
import { TYPE_COLORS } from "@/shared/constants";
import { getDisplayUrl } from "@/lib/media";
import {
  computeGroupBounds,
  collapsedCapsuleCenter,
  collapsedHitBox,
} from "@/lib/groupBounds";
import { hexAlpha } from "@/lib/utils";
import { GROUP_TITLE_HEIGHT } from "@/types/group";

// --- Image cache for Canvas rendering ---

export class CardImageCache {
  private cache = new Map<string, HTMLImageElement>();
  private loading = new Set<string>();
  private onLoad: () => void;

  constructor(onLoad: () => void) {
    this.onLoad = onLoad;
  }

  get(url: string): HTMLImageElement | null {
    const cached = this.cache.get(url);
    if (cached) return cached;

    if (this.loading.has(url)) return null;

    this.loading.add(url);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      this.cache.set(url, img);
      this.loading.delete(url);
      this.onLoad();
    };
    img.onerror = () => {
      this.loading.delete(url);
    };
    img.src = getDisplayUrl(url);
    return null;
  }

  clear() {
    this.cache.clear();
    this.loading.clear();
  }
}

function extractCardImageUrl(card: CanvasCard): string | null {
  const d = card.data as Record<string, unknown>;
  switch (card.type) {
    case "ai_image":
    case "ai_multiangle":
      return (d.imageUrl as string) || null;
    case "ai_tryon":
      return (d.resultImageUrl as string) || (d.personImageUrl as string) || null;
    default:
      return null;
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

function cardBg(): string {
  return isDark() ? "#141414" : "#ffffff";
}

function cardBorder(): string {
  return isDark() ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.1)";
}

function fgColor(alpha: number): string {
  return isDark()
    ? `rgba(250,250,250,${alpha})`
    : `rgba(10,10,10,${alpha})`;
}

export function drawCards(
  ctx: CanvasRenderingContext2D,
  cards: Map<string, CanvasCard>,
  selectedIds: Set<string>,
  zoom: number,
  projectId: string,
  imageCache?: CardImageCache,
  /** F7: 折叠组覆盖的 cardId 跳过(鸟瞰也走 DOM 端同语义)。 */
  collapsedCardIds?: ReadonlySet<string>,
) {
  const sorted = Array.from(cards.values())
    .filter(
      (c) =>
        c.projectId === projectId &&
        (!collapsedCardIds || !collapsedCardIds.has(c.id)),
    )
    .sort((a, b) => a.zIndex - b.zIndex);

  const bg = cardBg();
  const dark = isDark();
  const minBorder = Math.max(1, 1 / zoom);
  const minSelectedBorder = Math.max(2.5, 2 / zoom);

  // Progressive enhancement: as zoom shrinks, tint cards with type color
  // and boost border opacity so cards remain clearly visible.
  const lowZoom = zoom < 0.3;
  const zoomT = lowZoom ? Math.min(1, (0.3 - zoom) / 0.25) : 0;

  for (const card of sorted) {
    const isSelected = selectedIds.has(card.id);
    const r = 10;

    ctx.save();
    if (isSelected) {
      ctx.shadowColor = "rgba(129, 140, 248, 0.45)";
      ctx.shadowBlur = Math.max(12, 8 / zoom);
    }
    roundRect(ctx, card.x, card.y, card.width, card.height, r);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.restore();

    const imgUrl = imageCache ? extractCardImageUrl(card) : null;
    if (imgUrl && imageCache) {
      const img = imageCache.get(imgUrl);
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.save();
        roundRect(ctx, card.x, card.y, card.width, card.height, r);
        ctx.clip();

        const imgRatio = img.naturalWidth / img.naturalHeight;
        const cardRatio = card.width / card.height;
        let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
        if (imgRatio > cardRatio) {
          sw = img.naturalHeight * cardRatio;
          sx = (img.naturalWidth - sw) / 2;
        } else {
          sh = img.naturalWidth / cardRatio;
          sy = (img.naturalHeight - sh) / 2;
        }
        ctx.drawImage(img, sx, sy, sw, sh, card.x, card.y, card.width, card.height);
        ctx.restore();
      }
    }

    if (lowZoom) {
      const typeColor = card.color || TYPE_COLORS[card.type] || "#6B7280";
      ctx.save();
      roundRect(ctx, card.x, card.y, card.width, card.height, r);
      ctx.globalAlpha = 0.15 + zoomT * 0.35;
      ctx.fillStyle = typeColor;
      ctx.fill();
      ctx.restore();
    }

    roundRect(ctx, card.x, card.y, card.width, card.height, r);
    if (isSelected) {
      ctx.strokeStyle = "#818cf8";
    } else if (lowZoom) {
      const a = dark ? 0.12 + zoomT * 0.48 : 0.1 + zoomT * 0.4;
      ctx.strokeStyle = dark
        ? `rgba(255,255,255,${a})`
        : `rgba(0,0,0,${a})`;
    } else {
      ctx.strokeStyle = cardBorder();
    }
    ctx.lineWidth = isSelected ? minSelectedBorder : minBorder;
    ctx.stroke();
  }
}

const CURVE_OFFSET = 80;

function bezierPath(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  const dx = Math.abs(x2 - x1);
  const cp = Math.max(CURVE_OFFSET, dx * 0.4);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.bezierCurveTo(x1 + cp, y1, x2 - cp, y2, x2, y2);
}

export interface ConnectionRenderContext {
  /** F7: cardId → 它所在的折叠组(用于端点收到胶囊)。 */
  collapsedIdx?: Map<string, CardGroup>;
  /** F13: cardId → 它所在的任何组 id(用于跨组判定)。 */
  cardGroupIdx?: Map<string, string>;
}

export function drawConnections(
  ctx: CanvasRenderingContext2D,
  connections: Map<string, Connection>,
  cards: Map<string, CanvasCard>,
  projectId: string,
  selectedConnectionId: string | null,
  zoom: number = 1,
  groupCtx?: ConnectionRenderContext,
) {
  const minLine = Math.max(2, 1.5 / zoom);
  const minSelectedLine = Math.max(3, 2 / zoom);
  const alphaHex = zoom < 0.3 ? "b0" : "73";

  for (const conn of connections.values()) {
    if (conn.projectId !== projectId) continue;
    const src = cards.get(conn.sourceCardId);
    const tgt = cards.get(conn.targetCardId);
    if (!src || !tgt) continue;

    // F7: 端点 reroute + 同组隐藏
    const srcCollapsed = groupCtx?.collapsedIdx?.get(src.id);
    const tgtCollapsed = groupCtx?.collapsedIdx?.get(tgt.id);
    if (srcCollapsed && tgtCollapsed && srcCollapsed.id === tgtCollapsed.id) {
      continue;
    }

    let x1 = src.x + src.width;
    let y1 = src.y + src.height / 2;
    let x2 = tgt.x;
    let y2 = tgt.y + tgt.height / 2;
    if (srcCollapsed) {
      const c = collapsedCapsuleCenter(srcCollapsed, cards);
      if (c) {
        x1 = c.x;
        y1 = c.y;
      }
    }
    if (tgtCollapsed) {
      const c = collapsedCapsuleCenter(tgtCollapsed, cards);
      if (c) {
        x2 = c.x;
        y2 = c.y;
      }
    }

    const srcColor = src.color || TYPE_COLORS[src.type] || "#6B7280";
    const isSelected = conn.id === selectedConnectionId;

    // F13: 跨组虚线(鸟瞰沿用 DOM 端语义)
    const srcGroupId = groupCtx?.cardGroupIdx?.get(src.id);
    const tgtGroupId = groupCtx?.cardGroupIdx?.get(tgt.id);
    const crossGroup =
      (!!srcGroupId || !!tgtGroupId) && srcGroupId !== tgtGroupId;

    bezierPath(ctx, x1, y1, x2, y2);
    ctx.save();
    ctx.strokeStyle = isSelected ? "#818cf8" : srcColor + alphaHex;
    ctx.lineWidth = isSelected ? minSelectedLine : minLine;
    if (crossGroup) {
      const dashScale = Math.max(1, 1 / zoom);
      ctx.setLineDash([8 * dashScale, 6 * dashScale]);
    }
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * 在卡片之下绘制所有组矩形 + 标题胶囊。
 *
 * 顺序契约(由调用方保证): drawGrid → drawGroups → drawConnections → drawCards
 * 这样组矩形作为"卡片的视觉背景",连线在组上,卡片在最前。
 */
export function drawGroups(
  ctx: CanvasRenderingContext2D,
  groups: CardGroup[],
  cards: Map<string, CanvasCard>,
  zoom: number,
) {
  if (groups.length === 0) return;
  const lineW = Math.max(1, 1.5 / zoom);
  const titleFontPx = Math.max(10, 12 / zoom);

  for (const g of groups) {
    const bounds = computeGroupBounds(g, cards);
    if (!bounds) continue;

    if (g.collapsed) {
      // 折叠态只画胶囊
      const cap = collapsedHitBox(bounds);
      const r = cap.height / 2;
      ctx.save();
      ctx.fillStyle = hexAlpha(g.color, 0.22);
      ctx.strokeStyle = hexAlpha(g.color, 0.6);
      ctx.lineWidth = lineW;
      ctx.beginPath();
      ctx.moveTo(cap.x + r, cap.y);
      ctx.lineTo(cap.x + cap.width - r, cap.y);
      ctx.quadraticCurveTo(cap.x + cap.width, cap.y, cap.x + cap.width, cap.y + r);
      ctx.lineTo(cap.x + cap.width, cap.y + cap.height - r);
      ctx.quadraticCurveTo(
        cap.x + cap.width,
        cap.y + cap.height,
        cap.x + cap.width - r,
        cap.y + cap.height,
      );
      ctx.lineTo(cap.x + r, cap.y + cap.height);
      ctx.quadraticCurveTo(cap.x, cap.y + cap.height, cap.x, cap.y + cap.height - r);
      ctx.lineTo(cap.x, cap.y + r);
      ctx.quadraticCurveTo(cap.x, cap.y, cap.x + r, cap.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      continue;
    }

    // 展开态:整个 bounds 半透明 + 顶部标题栏底色
    ctx.save();
    ctx.fillStyle = hexAlpha(g.color, 0.08);
    ctx.strokeStyle = hexAlpha(g.color, 0.5);
    ctx.lineWidth = lineW;
    roundRect(ctx, bounds.x, bounds.y, bounds.width, bounds.height, 14);
    ctx.fill();
    ctx.stroke();

    // 标题栏顶条
    ctx.fillStyle = hexAlpha(g.color, 0.18);
    roundRect(
      ctx,
      bounds.x,
      bounds.y,
      bounds.width,
      GROUP_TITLE_HEIGHT,
      14,
    );
    ctx.fill();

    // 标题文字(zoom 小则省略)
    if (zoom > 0.25) {
      ctx.fillStyle = g.color;
      ctx.font = `600 ${titleFontPx}px system-ui, -apple-system, sans-serif`;
      ctx.textBaseline = "middle";
      const text = g.title;
      const padX = 8;
      ctx.fillText(
        text,
        bounds.x + padX,
        bounds.y + GROUP_TITLE_HEIGHT / 2,
        bounds.width - padX * 2,
      );
    }
    ctx.restore();
  }
}

export function drawGrid(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
) {
  const gridSize = 20;
  const screenGridSize = gridSize * viewport.zoom;
  if (screenGridSize < 3) return;

  const left = -viewport.x / viewport.zoom;
  const top = -viewport.y / viewport.zoom;
  const right = left + viewport.width / viewport.zoom;
  const bottom = top + viewport.height / viewport.zoom;

  const startX = Math.floor(left / gridSize) * gridSize;
  const startY = Math.floor(top / gridSize) * gridSize;

  ctx.fillStyle = fgColor(0.08);
  const dotR = Math.max(0.5, 0.5 / viewport.zoom);

  for (let x = startX; x <= right; x += gridSize) {
    for (let y = startY; y <= bottom; y += gridSize) {
      ctx.beginPath();
      ctx.arc(x, y, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export function drawSelectionBox(
  ctx: CanvasRenderingContext2D,
  box: { x: number; y: number; width: number; height: number },
) {
  ctx.strokeStyle = "rgba(59, 130, 246, 0.7)";
  ctx.fillStyle = "rgba(59, 130, 246, 0.08)";
  ctx.lineWidth = 1;
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  ctx.fillRect(box.x, box.y, box.width, box.height);
}
