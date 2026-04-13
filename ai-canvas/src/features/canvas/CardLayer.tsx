import { useMemo, memo } from "react";
import { useCanvasStore, type Viewport } from "@/stores/canvasStore";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import CardShell from "@/features/cards/CardShell";
import CardContent from "@/features/cards/CardContent";
import { TYPE_COLORS } from "@/shared/constants";
import { spatialIndex } from "@/lib/spatial-index";

const LOD_SCREEN_THRESHOLD = 80;
const VIEWPORT_MARGIN = 200;

function CardThumbnail({ card }: { card: CanvasCard }) {
  const color = card.color || TYPE_COLORS[card.type] || "#6B7280";
  return (
    <div
      className="absolute rounded-lg"
      style={{
        left: card.x,
        top: card.y,
        width: card.width,
        height: card.height,
        zIndex: card.zIndex,
        backgroundColor: `color-mix(in srgb, ${color} 15%, var(--color-card))`,
        border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
      }}
    />
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
