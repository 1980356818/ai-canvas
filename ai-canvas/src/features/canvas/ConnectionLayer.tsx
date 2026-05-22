import { memo, useMemo, useCallback } from "react";
import { useConnectionStore } from "@/stores/connectionStore";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard, Connection, Viewport } from "@/types";
import { useCanvasStore } from "@/stores/canvasStore";
import { TYPE_COLORS } from "@/shared/constants";
import { disconnectConnectionAndCleanup } from "@/lib/referenceConsistency";

const CURVE_OFFSET = 80;
/** 视口外多少世界像素仍渲染——给曲线弧线和滚动惯性留缓冲 */
const CONN_VIEWPORT_MARGIN = 300;

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

      {/* Base solid line — always visible */}
      <path
        d={d}
        fill="none"
        stroke={active ? `url(#${pulseId})` : `url(#${baseId})`}
        strokeWidth={active ? 4.5 : 4}
        strokeLinecap="round"
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

  const projectConns = useMemo(() => {
    const cards = useCardStore.getState().cards;
    const connections = useConnectionStore.getState().connections;
    const result: Array<{
      conn: Connection;
      d: string;
      srcColor: string;
      tgtColor: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }> = [];

    for (const conn of connections.values()) {
      if (conn.projectId !== projectId) continue;
      const src = cards.get(conn.sourceCardId);
      const tgt = cards.get(conn.targetCardId);
      if (!src || !tgt) continue;

      const srcPort = getPortPositions(src, dragOffsets).output;
      const tgtPort = getPortPositions(tgt, dragOffsets).input;

      // 视口剔除：连线的 bbox 与视口 bbox 不相交 → 跳过。
      // 用 source/target 端点构造 bbox（贝塞尔控制点不会超出 |x1-x2| × max(|y1-y2|, CURVE_OFFSET)）
      if (vpBounds) {
        const minX = Math.min(srcPort.x, tgtPort.x);
        const maxX = Math.max(srcPort.x, tgtPort.x);
        const minY = Math.min(srcPort.y, tgtPort.y);
        const maxY = Math.max(srcPort.y, tgtPort.y);
        if (
          maxX < vpBounds.left ||
          minX > vpBounds.right ||
          maxY < vpBounds.top ||
          minY > vpBounds.bottom
        ) {
          continue;
        }
      }

      const d = bezierPath(srcPort.x, srcPort.y, tgtPort.x, tgtPort.y);
      const srcColor = TYPE_COLORS[src.type] || "#6B7280";
      const tgtColor = TYPE_COLORS[tgt.type] || END_COLOR;
      result.push({
        conn,
        d,
        srcColor,
        tgtColor,
        x1: srcPort.x,
        y1: srcPort.y,
        x2: tgtPort.x,
        y2: tgtPort.y,
      });
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionsVersion, layoutVersion, projectId, dragOffsets, vpBounds]);

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
      {projectConns.map(({ conn, d, srcColor, tgtColor, x1, y1, x2, y2 }) => (
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
