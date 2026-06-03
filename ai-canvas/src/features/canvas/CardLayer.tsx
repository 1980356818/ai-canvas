import { useState, useEffect, useRef, memo } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import { useGroupStore } from "@/stores/groupStore";
import type { CanvasCard, Viewport } from "@/types";
import CardShell from "@/features/cards/CardShell";
import CardContent from "@/features/cards/CardContent";
import { TYPE_COLORS } from "@/shared/constants";
import { hexAlpha } from "@/lib/utils";
import { spatialIndex } from "@/lib/spatial-index";
import { preloadImages } from "@/lib/imagePreloader";
import { getDisplayUrl } from "@/lib/media";
import { buildCollapsedCardIndex } from "@/lib/groupBounds";

const LOD_SCREEN_THRESHOLD = 80;
// overscan(世界像素)：视口外多渲染一圈，作为平移手势的缓冲。手势中冻结可视集、纯 GPU
// 平移，移动消耗此余量；位移超过 useViewport 的 PAN_REFILL_WORLD 前提交补帧，故须 > 之。
const VIEWPORT_MARGIN = 300;
const PRELOAD_SCREEN_PX = 400;
// committed viewport 屏幕坐标位移阈值：小于此值不重算可视卡片列表（margin 留出缓冲）。
// 须 ≤ PAN_REFILL_WORLD × BIRDVIEW_EXIT_ZOOM（≈180×0.28≈50）：保证平移补帧提交（每
// PAN_REFILL_WORLD 世界像素一次）在 DOM 平移的最低 zoom（鸟瞰接管前）也必触发重建、
// 刷新 overscan 缓冲，否则缩小拖动时边缘会短暂空白。
const VP_REBUILD_PX = 45;
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

/**
 * 单卡渲染槽。**统一入口** —— 任何"展开渲染"的卡都必须经此组件。
 *
 * cardStore 规范（见 stores/cardStore.ts 顶部注释）要求单卡渲染
 * 用 `useCardStore(s => s.cards.get(id))` 订阅，而不是从父级 prop-drill
 * 一个静态 card 引用。这样 `updateCardData` 触发的纯 data 改动
 * （只 bump dataVersion，不动 layoutVersion）能直接推到该卡，无需
 * CardLayer 介入。zustand 默认 Object.is，单卡 selector 只在自身
 * 引用变化时让本 slot re-render，不会被"别的卡改 data"误触发。
 *
 * 历史 bug：CardLayer 直接把 fullCards 里的旧 card 对象 prop 给
 * CardShell/CardContent，而 fullCards 只在 layoutVersion 变时重算，
 * 导致生成结果（imageUrl/results 等 data 字段）写完后卡片不刷新，
 * 必须点击触发 bringToFront → layoutVersion +1 才能看到结果。
 */
const CardSlot = memo(function CardSlot({
  cardId,
  selected,
}: {
  cardId: string;
  selected: boolean;
}) {
  const card = useCardStore((s) => s.cards.get(cardId));
  if (!card) return null;
  return (
    <CardShell card={card} selected={selected}>
      <CardContent card={card} />
    </CardShell>
  );
});

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
  // 关键：**不**订阅 cards Map —— cardStore 每次 mutation 都复制出新 Map，
  // 而 `updateCardData`（编辑器改 prompt / 改 imageUrl 等非几何字段）
  // 不应导致整层重算。只订阅 layoutVersion；effect 内 imperative 取 cards。
  // bringToFront / sendToBack 也走 layoutVersion 通道，覆盖层级变化。
  const layoutVersion = useCardStore((s) => s.layoutVersion);
  const groupVersion = useGroupStore((s) => s.version);
  const selectedCardIds = useCanvasStore((s) => s.selectedCardIds);

  // fullCards 只存 id —— 真正渲染走 CardSlot 内部订阅，数据更新（dataVersion）
  // 由每个 slot 自己感知，CardLayer 只负责"哪些 id 当前可见"这层几何过滤。
  // thumbCards 维持 CanvasCard[]：缩略图只读几何 + color + type，全由 layoutVersion
  // 通道覆盖，无需订阅式渲染。
  const [{ fullCards, thumbCards }, setVisible] = useState<{
    fullCards: string[];
    thumbCards: CanvasCard[];
  }>({ fullCards: [], thumbCards: [] });

  // 保存上一次重算时的 viewport / 内容版本，用于阈值判断
  const lastVpRef = useRef<{ x: number; y: number; zoom: number; w: number; h: number } | null>(null);
  const lastLayoutRef = useRef(-1);
  const lastPidRef = useRef<string | null>(null);

  useEffect(() => {
    if (!projectId || viewport.width === 0 || viewport.height === 0) {
      setVisible({ fullCards: [], thumbCards: [] });
      lastVpRef.current = null;
      return;
    }

    const last = lastVpRef.current;
    const layoutChanged = lastLayoutRef.current !== layoutVersion;
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

    if (!vpSignificant && !layoutChanged && !pidChanged && !sizeChanged) {
      return;
    }

    const cards = useCardStore.getState().cards;
    // 折叠组覆盖的卡:不渲染(F7 真折叠)。索引在组 collapsed 切换或组 cardIds 变时重建,
    // 触发器是 groupVersion(deps 已包含)。
    const collapsedIdx = buildCollapsedCardIndex(projectId);

    const worldLeft = -viewport.x / viewport.zoom - VIEWPORT_MARGIN;
    const worldTop = -viewport.y / viewport.zoom - VIEWPORT_MARGIN;
    const worldRight = worldLeft + viewport.width / viewport.zoom + VIEWPORT_MARGIN * 2;
    const worldBottom = worldTop + viewport.height / viewport.zoom + VIEWPORT_MARGIN * 2;

    let visibleCards: CanvasCard[];

    if (spatialIndex.size > 0) {
      const ids = spatialIndex.query(worldLeft, worldTop, worldRight, worldBottom);
      visibleCards = ids
        .map((id) => cards.get(id))
        .filter(
          (c): c is CanvasCard =>
            c !== undefined && c.projectId === projectId && !collapsedIdx.has(c.id),
        )
        .sort((a, b) => a.zIndex - b.zIndex);
    } else {
      visibleCards = Array.from(cards.values())
        .filter(
          (c) =>
            c.projectId === projectId &&
            !collapsedIdx.has(c.id) &&
            c.x + c.width > worldLeft &&
            c.x < worldRight &&
            c.y + c.height > worldTop &&
            c.y < worldBottom,
        )
        .sort((a, b) => a.zIndex - b.zIndex);
    }

    const full: string[] = [];
    const thumb: CanvasCard[] = [];

    for (const c of visibleCards) {
      const screenW = c.width * viewport.zoom;
      const screenH = c.height * viewport.zoom;
      if (screenW < LOD_SCREEN_THRESHOLD && screenH < LOD_SCREEN_THRESHOLD) {
        thumb.push(c);
      } else {
        full.push(c.id);
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
    groupVersion,
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
    // imperative 取 cards：避免订阅整个 Map 导致非几何变更也触发预加载
    const cards = useCardStore.getState().cards;
    const urls: string[] = [];
    for (const id of ids) {
      const card = cards.get(id);
      if (!card || card.projectId !== projectId) continue;
      const imgUrl = getCardImageUrl(card);
      if (imgUrl) urls.push(getDisplayUrl(imgUrl));
    }
    if (urls.length > 0) preloadImages(urls);
  }, [viewport.x, viewport.y, viewport.zoom, viewport.width, viewport.height, projectId, layoutVersion]);

  return (
    <>
      {thumbCards.map((card) => (
        <CardThumbnail key={card.id} card={card} />
      ))}
      {fullCards.map((id) => (
        <CardSlot
          key={id}
          cardId={id}
          selected={selectedCardIds.has(id)}
        />
      ))}
    </>
  );
});
