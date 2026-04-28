import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import { MIN_ZOOM } from "@/shared/constants";

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
