import { memo, useMemo, useCallback } from "react";
import { useConnectionStore } from "@/stores/connectionStore";
import { useCardStore } from "@/stores/cardStore";
import { useGroupStore } from "@/stores/groupStore";
import type { CanvasCard, Connection, Viewport } from "@/types";
import { useCanvasStore } from "@/stores/canvasStore";
import { TYPE_COLORS } from "@/shared/constants";
import { disconnectConnectionAndCleanup } from "@/lib/referenceConsistency";
import {
  buildCollapsedCardIndex,
  collapsedCapsuleCenter,
} from "@/lib/groupBounds";

const CURVE_OFFSET = 80;
/** 视口外多少世界像素仍渲染——给曲线弧线 + 平移 overscan 缓冲留余量
 *  （须 > useViewport 的 PAN_REFILL_WORLD，使平移补帧赶在边缘空白前） */
const CONN_VIEWPORT_MARGIN = 400;

function bezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.abs(x2 - x1);
  const cp = Math.max(CURVE_OFFSET, dx * 0.4);
  return `M${x1},${y1} C${x1 + cp},${y1} ${x2 - cp},${y2} ${x2},${y2}`;
}

function bezierMidpoint(x1: number, y1: number, x2: number, y2: number) {
  const dx = Math.abs(x2 - x1);
  const cp = Math.max(CURVE_OFFSET, dx * 0.4);
  const cx1 = x1 + cp, cy1 = y1;
  const cx2 = x2 - cp, cy2 = y2;
  return {
    x: 0.125 * x1 + 0.375 * cx1 + 0.375 * cx2 + 0.125 * x2,
    y: 0.125 * y1 + 0.375 * cy1 + 0.375 * cy2 + 0.125 * y2,
  };
}

/** 空 offsets:allConns 用「已提交几何」建路径,拖拽位移由 liveConns 增量施加。 */
const EMPTY_OFFSETS: Map<string, { dx: number; dy: number }> = new Map();

function getPortPositions(
  card: CanvasCard,
  dragOffsets: Map<string, { dx: number; dy: number }>,
) {
  const off = dragOffsets.get(card.id);
  const ox = off?.dx ?? 0;
  const oy = off?.dy ?? 0;
  return {
    output: { x: card.x + card.width + ox, y: card.y + card.height / 2 + oy },
    input: { x: card.x + ox, y: card.y + card.height / 2 + oy },
  };
}

const END_COLOR = "#a855f7";

interface WireProps {
  id: string;
  d: string;
  gradientId: string;
  sourceColor: string;
  targetColor: string;
  selected: boolean;
  hovered: boolean;
  flowing: boolean;
  /** F13: 跨组连线视觉差异化(虚线 dash + 略提亮)。 */
  crossGroup: boolean;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  onDelete: (id: string) => void;
  onHoverIn: (id: string) => void;
  onHoverOut: () => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
}

const Wire = memo(function Wire({
  id,
  d,
  gradientId: _gradientId,
  sourceColor,
  targetColor,
  selected,
  hovered,
  flowing,
  crossGroup,
  x1,
  y1,
  x2,
  y2,
  onDelete,
  onHoverIn,
  onHoverOut,
  onContextMenu,
}: WireProps) {
  const active = selected || hovered || flowing;
  const baseId = `base-${id}`;
  const pulseId = `pulse-${id}`;
  const mid = bezierMidpoint(x1, y1, x2, y2);
  // F13: 跨组连线视觉差异 — base 加 dash,pulse 不变以保留动画感
  const baseDash = crossGroup ? "8 6" : undefined;

  return (
    <g>
      <defs>
        <linearGradient id={baseId} x1={x1} y1={y1} x2={x2} y2={y2} gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={sourceColor} stopOpacity={0.9} />
          <stop offset="100%" stopColor={targetColor} stopOpacity={0.9} />
        </linearGradient>
        <linearGradient id={pulseId} x1={x1} y1={y1} x2={x2} y2={y2} gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={flowing ? "#4ade80" : sourceColor} />
          <stop offset="100%" stopColor={flowing ? "#22c55e" : targetColor} />
        </linearGradient>
      </defs>

      {/* Hit area — explicit pointerEvents to override parent's none */}
      <path
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={22}
        style={{ cursor: "pointer", pointerEvents: "auto" }}
        onClick={() => onDelete(id)}
        onMouseEnter={() => onHoverIn(id)}
        onMouseLeave={onHoverOut}
        onContextMenu={(e) => onContextMenu(e, id)}
      />

      {/* Soft glow — 仅在 active（hover/select/flow）时显示。
          `filter:blur` 触发 GPU 合成层，500+ 条连线常驻 blur 会逼近显存上限，
          所以 idle 状态绝不能开。 */}
      {active && (
        <path
          d={d}
          fill="none"
          stroke={flowing ? "#22c55e" : sourceColor}
          strokeWidth={flowing ? 16 : 12}
          strokeLinecap="round"
          opacity={flowing ? 0.18 : 0.1}
          style={{ pointerEvents: "none", filter: "blur(4px)" }}
        />
      )}

      {/* Base solid line — always visible. 跨组用 dash 提示边界。 */}
      <path
        d={d}
        fill="none"
        stroke={active ? `url(#${pulseId})` : `url(#${baseId})`}
        strokeWidth={active ? 4.5 : 4}
        strokeLinecap="round"
        strokeDasharray={baseDash}
        style={{ pointerEvents: "none" }}
      />

      {/* Traveling light pulse — always visible, brighter when active */}
      <path
        d={d}
        fill="none"
        stroke={`url(#${pulseId})`}
        strokeWidth={flowing ? 6 : active ? 5.5 : 4}
        strokeLinecap="round"
        opacity={flowing ? 1 : active ? 0.9 : 0.65}
        style={{ pointerEvents: "none" }}
        className={flowing ? "wire-sweep-data" : active ? "wire-sweep-active" : "wire-sweep-idle-anim"}
      />

      {/* Selected highlight */}
      {selected && (
        <path
          d={d}
          fill="none"
          stroke="white"
          strokeWidth={1}
          strokeLinecap="round"
          opacity={0.35}
          style={{ pointerEvents: "none" }}
          className="wire-sweep-ring"
        />
      )}

      {/* Delete button at midpoint — visible on hover */}
      {hovered && (
        <g style={{ pointerEvents: "none" }}>
          <circle cx={mid.x} cy={mid.y} r={10} fill="#ef4444" opacity={0.9} />
          <circle cx={mid.x} cy={mid.y} r={10} fill="none" stroke="white" strokeWidth={1.5} opacity={0.3} />
          <line x1={mid.x - 3.5} y1={mid.y - 3.5} x2={mid.x + 3.5} y2={mid.y + 3.5} stroke="white" strokeWidth={2} strokeLinecap="round" />
          <line x1={mid.x + 3.5} y1={mid.y - 3.5} x2={mid.x - 3.5} y2={mid.y + 3.5} stroke="white" strokeWidth={2} strokeLinecap="round" />
        </g>
      )}
    </g>
  );
});

function DraftWirePath() {
  const draft = useConnectionStore((s) => s.draftWire);
  // v5：订阅 layoutVersion 而非 cards Map。本组件只在拖拽端口期间挂载
  // （draft != null），位置变化由 layoutVersion 触发；data 变化无需重渲。
  // 旧写法 `useCardStore((s) => s.cards)` 会让任意 updateCardData 都重
  // evaluate 本组件（即使 draft === null 直接 return null 也白白做一次
  // hook diff + render 调用）。
  useCardStore((s) => s.layoutVersion);
  const dragOffsets = useCanvasStore((s) => s.dragOffsets);

  if (!draft) return null;

  const sourceCard = useCardStore.getState().cards.get(draft.sourceCardId);
  if (!sourceCard) return null;

  const ports = getPortPositions(sourceCard, dragOffsets);
  const d = bezierPath(ports.output.x, ports.output.y, draft.endX, draft.endY);
  const srcColor = TYPE_COLORS[sourceCard.type] || "#6B7280";

  return (
    <g>
      <defs>
        <linearGradient id="draft-grad" x1={ports.output.x} y1={ports.output.y} x2={draft.endX} y2={draft.endY} gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={srcColor} />
          <stop offset="100%" stopColor={srcColor} stopOpacity="0.35" />
        </linearGradient>
      </defs>
      {/* Base solid line */}
      <path
        d={d}
        fill="none"
        stroke={srcColor}
        strokeWidth={2}
        strokeLinecap="round"
        opacity={0.4}
        className="pointer-events-none"
      />
      {/* Traveling pulse */}
      <path
        d={d}
        fill="none"
        stroke="url(#draft-grad)"
        strokeWidth={2.5}
        strokeLinecap="round"
        opacity={0.7}
        className="wire-draft"
      />
      <circle cx={draft.endX} cy={draft.endY} r={4} fill={srcColor} opacity={0.5} />
    </g>
  );
}

interface ConnectionLayerProps {
  projectId: string;
  viewport: Viewport;
  onConnectionContextMenu?: (e: React.MouseEvent, connectionId: string) => void;
}

export default memo(function ConnectionLayer({
  projectId,
  viewport,
  onConnectionContextMenu,
}: ConnectionLayerProps) {
  // v5：订阅 connectionsVersion 而非 connections Map 引用。Map 引用每次 add/remove
  // 都换新，旧写法会让 projectConns useMemo deps 触发，但实际上靠数字 deps 等价。
  const connectionsVersion = useConnectionStore((s) => s.connectionsVersion);
  const layoutVersion = useCardStore((s) => s.layoutVersion);
  const groupVersion = useGroupStore((s) => s.version);
  const dragOffsets = useCanvasStore((s) => s.dragOffsets);
  const selectedId = useConnectionStore((s) => s.selectedConnectionId);
  const hoveredId = useConnectionStore((s) => s.hoveredConnectionId);
  const flowingIds = useConnectionStore((s) => s.flowingConnectionIds);
  const setHovered = useConnectionStore((s) => s.setHoveredConnectionId);

  // 视口边界（world 坐标），带 margin 给曲线弧线 + 滚动惯性留缓冲。
  // 仅保留 bbox 与 viewport 相交的连线，避免画布外几百条线常驻 SVG 树。
  const vpBounds = useMemo(() => {
    if (viewport.width === 0 || viewport.height === 0) return null;
    const left = -viewport.x / viewport.zoom - CONN_VIEWPORT_MARGIN;
    const top = -viewport.y / viewport.zoom - CONN_VIEWPORT_MARGIN;
    const right = left + viewport.width / viewport.zoom + CONN_VIEWPORT_MARGIN * 2;
    const bottom = top + viewport.height / viewport.zoom + CONN_VIEWPORT_MARGIN * 2;
    return { left, top, right, bottom };
  }, [viewport.x, viewport.y, viewport.zoom, viewport.width, viewport.height]);

  // 所有连线几何（世界坐标，与缩放无关）。**不依赖 vpBounds**：缩放/平移时
  // bezier path / 折叠索引 / 分组索引都不需要重算，只有内容/布局/拖拽变化才重算。
  const allConns = useMemo(() => {
    const cards = useCardStore.getState().cards;
    const connections = useConnectionStore.getState().connections;
    // F7: collapsed 索引 = cardId → 它所属的折叠组(用于端点 reroute / 整条隐藏)
    const collapsedIdx = buildCollapsedCardIndex(projectId);
    // F13: cardId → 它所属的任何组(用于跨组连线视觉差异)
    // 注意:展开组也算"在某个组里",跨组判定看的是 sourceGroup !== targetGroup。
    const cardGroupIdx = new Map<string, string>();
    for (const g of useGroupStore.getState().getGroupsByProject(projectId)) {
      for (const cid of g.cardIds) cardGroupIdx.set(cid, g.id);
    }

    const result: Array<{
      conn: Connection;
      d: string;
      srcColor: string;
      tgtColor: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      /** 跨组(含 collapsed 端点替换) → 视觉差异化(F13) */
      crossGroup: boolean;
    }> = [];

    for (const conn of connections.values()) {
      if (conn.projectId !== projectId) continue;
      const src = cards.get(conn.sourceCardId);
      const tgt = cards.get(conn.targetCardId);
      if (!src || !tgt) continue;

      const srcCollapsedGroup = collapsedIdx.get(src.id);
      const tgtCollapsedGroup = collapsedIdx.get(tgt.id);

      // 两端都在同一个 collapsed 组 → 整条隐藏(组内引用不应在折叠态可见)
      if (
        srcCollapsedGroup &&
        tgtCollapsedGroup &&
        srcCollapsedGroup.id === tgtCollapsedGroup.id
      ) {
        continue;
      }

      // 端点用「已提交几何」算(EMPTY_OFFSETS,不带拖拽位移);拖拽跟手由下方
      // liveConns 仅对「可见 + 端点正被拖动」的连线增量施加,避免每帧 O(总连线) 重建路径。
      let srcPort = getPortPositions(src, EMPTY_OFFSETS).output;
      let tgtPort = getPortPositions(tgt, EMPTY_OFFSETS).input;
      if (srcCollapsedGroup) {
        const c = collapsedCapsuleCenter(srcCollapsedGroup, cards);
        if (c) srcPort = c;
      }
      if (tgtCollapsedGroup) {
        const c = collapsedCapsuleCenter(tgtCollapsedGroup, cards);
        if (c) tgtPort = c;
      }

      const d = bezierPath(srcPort.x, srcPort.y, tgtPort.x, tgtPort.y);
      const srcColor = TYPE_COLORS[src.type] || "#6B7280";
      const tgtColor = TYPE_COLORS[tgt.type] || END_COLOR;

      // F13: 跨组判定 — 任一端在某组而另一端不在同一组 → 跨组
      const srcGroupId = cardGroupIdx.get(src.id);
      const tgtGroupId = cardGroupIdx.get(tgt.id);
      const crossGroup =
        (!!srcGroupId || !!tgtGroupId) && srcGroupId !== tgtGroupId;

      result.push({
        conn,
        d,
        srcColor,
        tgtColor,
        x1: srcPort.x,
        y1: srcPort.y,
        x2: tgtPort.x,
        y2: tgtPort.y,
        crossGroup,
      });
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionsVersion, layoutVersion, groupVersion, projectId]);

  // 视口剔除：仅做 bbox 比较（廉价）。viewport 变化（缩放/平移）时只跑这层 filter，
  // 不再触发 allConns 的全量 path / 索引重算 —— 这是缩放卡顿的主因之一。
  const projectConns = useMemo(() => {
    if (!vpBounds) return allConns;
    return allConns.filter(({ x1, y1, x2, y2 }) => {
      const minX = Math.min(x1, x2);
      const maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2);
      const maxY = Math.max(y1, y2);
      return !(
        maxX < vpBounds.left ||
        minX > vpBounds.right ||
        maxY < vpBounds.top ||
        minY > vpBounds.bottom
      );
    });
  }, [allConns, vpBounds]);

  // 拖拽实时跟手:仅对「可见 + 端点正被拖动」的连线增量改写端点与路径。
  // 非拖拽(dragOffsets 空)时直接复用 projectConns;未被拖动的连线返回同一引用,
  // <Wire> 的 memo 命中、零 reconcile。每帧代价 = O(可见连线),与总连线数无关。
  const liveConns = useMemo(() => {
    if (dragOffsets.size === 0) return projectConns;
    return projectConns.map((w) => {
      const so = dragOffsets.get(w.conn.sourceCardId);
      const to = dragOffsets.get(w.conn.targetCardId);
      if (!so && !to) return w;
      const x1 = w.x1 + (so?.dx ?? 0);
      const y1 = w.y1 + (so?.dy ?? 0);
      const x2 = w.x2 + (to?.dx ?? 0);
      const y2 = w.y2 + (to?.dy ?? 0);
      return { ...w, x1, y1, x2, y2, d: bezierPath(x1, y1, x2, y2) };
    });
  }, [projectConns, dragOffsets]);

  const handleDelete = useCallback((id: string) => {
    disconnectConnectionAndCleanup(id);
  }, []);
  const handleHoverIn = useCallback((id: string) => setHovered(id), [setHovered]);
  const handleHoverOut = useCallback(() => setHovered(null), [setHovered]);
  const handleContextMenu = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.preventDefault();
      e.stopPropagation();
      onConnectionContextMenu?.(e, id);
    },
    [onConnectionContextMenu],
  );

  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      {liveConns.map(({ conn, d, srcColor, tgtColor, x1, y1, x2, y2, crossGroup }) => (
        <Wire
          key={conn.id}
          id={conn.id}
          d={d}
          gradientId={`grad-${conn.id}`}
          sourceColor={srcColor}
          targetColor={tgtColor}
          selected={selectedId === conn.id}
          hovered={hoveredId === conn.id}
          flowing={flowingIds.has(conn.id)}
          crossGroup={crossGroup}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          onDelete={handleDelete}
          onHoverIn={handleHoverIn}
          onHoverOut={handleHoverOut}
          onContextMenu={handleContextMenu}
        />
      ))}
      <DraftWirePath />
    </svg>
  );
});
