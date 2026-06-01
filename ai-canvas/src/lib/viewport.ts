import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import { MIN_ZOOM } from "@/shared/constants";

export interface FocusOnCardOptions {
  /** 居中后的最小缩放(防止小卡被放大过头)。默认 0.75。 */
  minZoom?: number;
  /** 居中后的最大缩放。默认保持当前缩放,不强制。 */
  maxZoom?: number;
}

/**
 * 把视口居中到指定卡片。用于:
 *   - 组运行失败时跳转到失败节点 (F8)
 *   - Agent 工具调用 navigate_to_card
 *   - 通用"定位"场景
 *
 * 不改 zoom 除非当前太小看不清(<minZoom)。返回 true=移动了,false=卡片不存在。
 */
export function focusOnCard(
  cardId: string,
  opts: FocusOnCardOptions = {},
): boolean {
  const card = useCardStore.getState().getCard(cardId);
  if (!card) return false;

  const vp = useCanvasStore.getState().viewport;
  const vw = vp.width || window.innerWidth;
  const vh = vp.height || window.innerHeight;
  if (vw <= 0 || vh <= 0) return false;

  const minZoom = opts.minZoom ?? 0.75;
  const maxZoom = opts.maxZoom ?? vp.zoom;
  let zoom = vp.zoom;
  if (zoom < minZoom) zoom = minZoom;
  if (zoom > maxZoom) zoom = maxZoom;

  const cx = card.x + card.width / 2;
  const cy = card.y + card.height / 2;
  useCanvasStore.getState().setViewport({
    zoom,
    x: vw / 2 - cx * zoom,
    y: vh / 2 - cy * zoom,
  });
  return true;
}

/**
 * Fit all cards of a project into the current canvas viewport.
 * Returns false when there are no cards or the viewport hasn't been
 * measured yet.
 */
export function fitCardsToViewport(projectId: string, padding = 60): boolean {
  const cards = useCardStore.getState().getCardsByProject(projectId);
  if (cards.length === 0) return false;

  const vp = useCanvasStore.getState().viewport;
  const vw = vp.width || window.innerWidth;
  const vh = vp.height || window.innerHeight;
  if (vw <= 0 || vh <= 0) return false;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of cards) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + c.width);
    maxY = Math.max(maxY, c.y + c.height);
  }

  const bw = maxX - minX;
  const bh = maxY - minY;
  const zoom = Math.max(
    MIN_ZOOM,
    Math.min(
      (vw - padding * 2) / Math.max(bw, 1),
      (vh - padding * 2) / Math.max(bh, 1),
      2,
    ),
  );

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  useCanvasStore.getState().setViewport({
    zoom,
    x: vw / 2 - cx * zoom,
    y: vh / 2 - cy * zoom,
  });
  return true;
}

/**
 * Schedule a fit-to-cards call once the canvas has rendered and its
 * size has been measured. Retries up to `maxAttempts` rAFs.
 */
export function scheduleFitCardsToViewport(
  projectId: string,
  padding = 60,
  maxAttempts = 30,
): void {
  let attempts = 0;
  const tryFit = () => {
    attempts += 1;
    if (fitCardsToViewport(projectId, padding)) return;
    if (attempts >= maxAttempts) return;
    requestAnimationFrame(tryFit);
  };
  requestAnimationFrame(tryFit);
}
