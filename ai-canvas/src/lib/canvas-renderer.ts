import type { CanvasCard, Connection, Viewport } from "@/types";
import { TYPE_COLORS } from "@/shared/constants";
import { getDisplayUrl } from "@/lib/media";

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
  return isDark() ? "#0a0a0a" : "#ffffff";
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
  _zoom: number,
  projectId: string,
  imageCache?: CardImageCache,
) {
  const sorted = Array.from(cards.values())
    .filter((c) => c.projectId === projectId)
    .sort((a, b) => a.zIndex - b.zIndex);

  const bg = cardBg();
  const border = cardBorder();

  for (const card of sorted) {
    const isSelected = selectedIds.has(card.id);
    const r = 10;

    // White/dark solid background — same as DOM CardShell bg-card
    ctx.save();
    if (isSelected) {
      ctx.shadowColor = "rgba(129, 140, 248, 0.45)";
      ctx.shadowBlur = 12;
    }
    roundRect(ctx, card.x, card.y, card.width, card.height, r);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.restore();

    // Draw image on top of background if available
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

    // Border — matches DOM CardShell border appearance
    roundRect(ctx, card.x, card.y, card.width, card.height, r);
    ctx.strokeStyle = isSelected ? "#818cf8" : border;
    ctx.lineWidth = isSelected ? 2.5 : 1;
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

export function drawConnections(
  ctx: CanvasRenderingContext2D,
  connections: Map<string, Connection>,
  cards: Map<string, CanvasCard>,
  projectId: string,
  selectedConnectionId: string | null,
) {
  for (const conn of connections.values()) {
    if (conn.projectId !== projectId) continue;
    const src = cards.get(conn.sourceCardId);
    const tgt = cards.get(conn.targetCardId);
    if (!src || !tgt) continue;

    const x1 = src.x + src.width;
    const y1 = src.y + src.height / 2;
    const x2 = tgt.x;
    const y2 = tgt.y + tgt.height / 2;

    const srcColor = src.color || TYPE_COLORS[src.type] || "#6B7280";
    const isSelected = conn.id === selectedConnectionId;

    bezierPath(ctx, x1, y1, x2, y2);
    ctx.strokeStyle = isSelected ? "#818cf8" : srcColor + "73";
    ctx.lineWidth = isSelected ? 3 : 2;
    ctx.stroke();
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
