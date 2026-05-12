import { useState, useEffect, useRef, memo } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard, Viewport } from "@/types";
import CardShell from "@/features/cards/CardShell";
import CardContent from "@/features/cards/CardContent";
import { TYPE_COLORS } from "@/shared/constants";
import { hexAlpha } from "@/lib/utils";
import { spatialIndex } from "@/lib/spatial-index";
import { preloadImages } from "@/lib/imagePreloader";
import { getDisplayUrl } from "@/lib/media";

const LOD_SCREEN_THRESHOLD = 80;
const VIEWPORT_MARGIN = 200;
const PRELOAD_SCREEN_PX = 400;
// viewport 屏幕坐标位移阈值：小于此值不重算可视卡片列表（margin 留出缓冲）
const VP_REBUILD_PX = 80;
// zoom 相对变化阈值：小于此值不重算（影响 LOD 切换可忽略）
const VP_REBUILD_ZOOM_RATIO = 0.05;

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
        backgroundColor: hexAlpha(color, 0.35),
        border: `2px solid ${hexAlpha(color, 0.6)}`,
        boxShadow: `inset 0 0 0 1px ${hexAlpha(color, 0.12)}`,
        fontSize: Math.min(card.width, card.height) * 0.35,
        color: hexAlpha(color, 0.8),
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

  const [{ fullCards, thumbCards }, setVisible] = useState<{
    fullCards: CanvasCard[];
    thumbCards: CanvasCard[];
  }>({ fullCards: [], thumbCards: [] });

  // 保存上一次重算时的 viewport / 内容版本，用于阈值判断
  const lastVpRef = useRef<{ x: number; y: number; zoom: number; w: number; h: number } | null>(null);
  const lastLayoutRef = useRef(-1);
  const lastCardsRef = useRef<typeof cards | null>(null);
  const lastPidRef = useRef<string | null>(null);

  useEffect(() => {
    if (!projectId || viewport.width === 0 || viewport.height === 0) {
      setVisible({ fullCards: [], thumbCards: [] });
      lastVpRef.current = null;
      return;
    }

    const last = lastVpRef.current;
    const layoutChanged = lastLayoutRef.current !== layoutVersion;
    const cardsChanged = lastCardsRef.current !== cards;
    const pidChanged = lastPidRef.current !== projectId;
    const sizeChanged =
      !last || last.w !== viewport.width || last.h !== viewport.height;

    let vpSignificant = !last;
    if (last && !vpSignificant) {
      const dx = Math.abs(viewport.x - last.x);
      const dy = Math.abs(viewport.y - last.y);
      const dz = Math.abs(viewport.zoom - last.zoom) / last.zoom;
      if (dx >= VP_REBUILD_PX || dy >= VP_REBUILD_PX || dz >= VP_REBUILD_ZOOM_RATIO) {
        vpSignificant = true;
      }
    }

    if (!vpSignificant && !layoutChanged && !cardsChanged && !pidChanged && !sizeChanged) {
      return;
    }

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

    lastVpRef.current = {
      x: viewport.x,
      y: viewport.y,
      zoom: viewport.zoom,
      w: viewport.width,
      h: viewport.height,
    };
    lastLayoutRef.current = layoutVersion;
    lastCardsRef.current = cards;
    lastPidRef.current = projectId;
    setVisible({ fullCards: full, thumbCards: thumb });
  }, [
    viewport.x,
    viewport.y,
    viewport.zoom,
    viewport.width,
    viewport.height,
    projectId,
    layoutVersion,
    cards,
  ]);

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
