import { useMemo, useEffect, useRef, memo } from "react";
import { useCanvasStore, type Viewport } from "@/stores/canvasStore";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import CardShell from "@/features/cards/CardShell";
import CardContent from "@/features/cards/CardContent";
import { TYPE_COLORS } from "@/shared/constants";
import { spatialIndex } from "@/lib/spatial-index";
import { preloadImages } from "@/lib/imagePreloader";
import { getDisplayUrl } from "@/lib/media";

const LOD_SCREEN_THRESHOLD = 80;
const VIEWPORT_MARGIN = 200;
const PRELOAD_SCREEN_PX = 400;

function getCardImageUrl(card: CanvasCard): string | undefined {
  if (card.type === "ai_image" || card.type === "ai_multiangle") {
    return (card.data as { imageUrl?: string }).imageUrl;
  }
  if (card.type === "ai_tryon") {
    const d = card.data as { resultImageUrl?: string; personImageUrl?: string };
    return d.resultImageUrl || d.personImageUrl;
  }
  return undefined;
}

const TYPE_LABELS: Record<string, string> = {
  ai_chat: "T",
  ai_image: "I",
  ai_video: "V",
  ai_tryon: "换",
  ai_multiangle: "M",
  text: "T",
  sticky_note: "N",
};

function CardThumbnail({ card }: { card: CanvasCard }) {
  const color = card.color || TYPE_COLORS[card.type] || "#6B7280";
  const label = TYPE_LABELS[card.type] ?? "?";
  return (
    <div
      className="absolute flex items-center justify-center rounded-lg"
      style={{
        left: card.x,
        top: card.y,
        width: card.width,
        height: card.height,
        zIndex: card.zIndex,
        backgroundColor: `color-mix(in srgb, ${color} 35%, var(--color-card))`,
        border: `2px solid color-mix(in srgb, ${color} 60%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 12%, transparent)`,
        fontSize: Math.min(card.width, card.height) * 0.35,
        color: `color-mix(in srgb, ${color} 80%, var(--color-card-foreground))`,
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {label}
    </div>
  );
}

interface CardLayerProps {
  projectId: string | null;
  viewport: Viewport;
}

export default memo(function CardLayer({ projectId, viewport }: CardLayerProps) {
  const cards = useCardStore((s) => s.cards);
  const layoutVersion = useCardStore((s) => s.layoutVersion);
  const selectedCardIds = useCanvasStore((s) => s.selectedCardIds);

  const { fullCards, thumbCards } = useMemo(() => {
    if (!projectId || viewport.width === 0 || viewport.height === 0)
      return { fullCards: [] as CanvasCard[], thumbCards: [] as CanvasCard[] };

    const worldLeft = -viewport.x / viewport.zoom - VIEWPORT_MARGIN;
    const worldTop = -viewport.y / viewport.zoom - VIEWPORT_MARGIN;
    const worldRight = worldLeft + viewport.width / viewport.zoom + VIEWPORT_MARGIN * 2;
    const worldBottom = worldTop + viewport.height / viewport.zoom + VIEWPORT_MARGIN * 2;

    let visibleCards: CanvasCard[];

    if (spatialIndex.size > 0) {
      const ids = spatialIndex.query(worldLeft, worldTop, worldRight, worldBottom);
      visibleCards = ids
        .map((id) => cards.get(id))
        .filter((c): c is CanvasCard => c !== undefined && c.projectId === projectId)
        .sort((a, b) => a.zIndex - b.zIndex);
    } else {
      visibleCards = Array.from(cards.values())
        .filter(
          (c) =>
            c.projectId === projectId &&
            c.x + c.width > worldLeft &&
            c.x < worldRight &&
            c.y + c.height > worldTop &&
            c.y < worldBottom,
        )
        .sort((a, b) => a.zIndex - b.zIndex);
    }

    const full: CanvasCard[] = [];
    const thumb: CanvasCard[] = [];

    for (const c of visibleCards) {
      const screenW = c.width * viewport.zoom;
      const screenH = c.height * viewport.zoom;
      if (screenW < LOD_SCREEN_THRESHOLD && screenH < LOD_SCREEN_THRESHOLD) {
        thumb.push(c);
      } else {
        full.push(c);
      }
    }
    return { fullCards: full, thumbCards: thumb };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, projectId, viewport, layoutVersion]);

  const prevVp = useRef({ x: viewport.x, y: viewport.y });

  useEffect(() => {
    if (!projectId || spatialIndex.size === 0) return;

    const dx = viewport.x - prevVp.current.x;
    const dy = viewport.y - prevVp.current.y;
    prevVp.current = { x: viewport.x, y: viewport.y };

    const margin = PRELOAD_SCREEN_PX / viewport.zoom;
    const dirX = dx !== 0 ? -Math.sign(dx) : 0;
    const dirY = dy !== 0 ? -Math.sign(dy) : 0;

    const baseLeft = -viewport.x / viewport.zoom;
    const baseTop = -viewport.y / viewport.zoom;
    const baseRight = baseLeft + viewport.width / viewport.zoom;
    const baseBottom = baseTop + viewport.height / viewport.zoom;

    const pLeft = baseLeft - margin + (dirX < 0 ? dirX * margin : 0);
    const pTop = baseTop - margin + (dirY < 0 ? dirY * margin : 0);
    const pRight = baseRight + margin + (dirX > 0 ? dirX * margin : 0);
    const pBottom = baseBottom + margin + (dirY > 0 ? dirY * margin : 0);

    const ids = spatialIndex.query(pLeft, pTop, pRight, pBottom);
    const urls: string[] = [];
    for (const id of ids) {
      const card = cards.get(id);
      if (!card || card.projectId !== projectId) continue;
      const imgUrl = getCardImageUrl(card);
      if (imgUrl) urls.push(getDisplayUrl(imgUrl));
    }
    if (urls.length > 0) preloadImages(urls);
  }, [viewport.x, viewport.y, viewport.zoom, viewport.width, viewport.height, projectId, cards]);

  return (
    <>
      {thumbCards.map((card) => (
        <CardThumbnail key={card.id} card={card} />
      ))}
      {fullCards.map((card) => (
        <CardShell
          key={card.id}
          card={card}
          selected={selectedCardIds.has(card.id)}
        >
          <CardContent card={card} />
        </CardShell>
      ))}
    </>
  );
});
