import { useRef, useMemo, useState, useCallback } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { useViewport } from "./hooks/useViewport";
import { useSelection } from "./hooks/useSelection";
import CardShell from "@/features/cards/CardShell";
import CardContent from "@/features/cards/CardContent";
import FloatingEditor from "@/features/editor/FloatingEditor";
import ZoomControls from "./ZoomControls";
import QuickCreateMenu, { type QuickMenuPosition } from "./QuickCreateMenu";

export default function CanvasContainer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    viewport,
    onWheel,
    onPointerDown: vpPointerDown,
    onPointerMove: vpPointerMove,
    onPointerUp: vpPointerUp,
    screenToCanvas,
  } = useViewport(containerRef);

  const {
    selectionBox,
    onCanvasPointerDown,
    onCanvasPointerMove,
    onCanvasPointerUp,
  } = useSelection();

  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const cards = useCardStore((s) => s.cards);
  const selectedCardIds = useCanvasStore((s) => s.selectedCardIds);
  const showContextMenu = useUIStore((s) => s.showContextMenu);

  const [quickMenu, setQuickMenu] = useState<QuickMenuPosition | null>(null);
  const closeQuickMenu = useCallback(() => setQuickMenu(null), []);

  const projectCards = useMemo(() => {
    if (!currentProjectId) return [];
    return Array.from(cards.values())
      .filter((c) => c.projectId === currentProjectId)
      .sort((a, b) => a.zIndex - b.zIndex);
  }, [cards, currentProjectId]);

  const visibleCards = useMemo(() => {
    if (viewport.width === 0 || viewport.height === 0) return projectCards;
    const MARGIN = 200;
    const worldLeft = -viewport.x / viewport.zoom - MARGIN;
    const worldTop = -viewport.y / viewport.zoom - MARGIN;
    const worldRight = worldLeft + viewport.width / viewport.zoom + MARGIN * 2;
    const worldBottom = worldTop + viewport.height / viewport.zoom + MARGIN * 2;
    return projectCards.filter(
      (c) =>
        c.x + c.width > worldLeft &&
        c.x < worldRight &&
        c.y + c.height > worldTop &&
        c.y < worldBottom,
    );
  }, [projectCards, viewport]);

  const handlePointerDown = (e: React.PointerEvent) => {
    vpPointerDown(e);
    const target = e.target as HTMLElement;
    const isCanvasBg =
      target === containerRef.current ||
      target.dataset.canvasBackground !== undefined;
    onCanvasPointerDown(e, isCanvasBg);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    vpPointerMove(e);
    onCanvasPointerMove(e);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    vpPointerUp();
    onCanvasPointerUp(e);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, "canvas");
  };

  const handleCanvasClick = (e: React.MouseEvent) => {
    if (
      e.target === containerRef.current ||
      (e.target as HTMLElement).dataset.canvasBackground !== undefined
    ) {
      useCanvasStore.getState().clearSelection();
    }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const isCanvasBg =
      target === containerRef.current ||
      target.dataset.canvasBackground !== undefined;
    if (!isCanvasBg || !currentProjectId) return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const canvasPos = screenToCanvas(e.clientX, e.clientY);
    setQuickMenu({
      screenX: e.clientX - rect.left,
      screenY: e.clientY - rect.top,
      canvasX: canvasPos.x,
      canvasY: canvasPos.y,
    });
  };

  return (
    <div
      ref={containerRef}
      data-canvas-viewport
      className="relative flex-1 overflow-hidden bg-background"
      style={{
        backgroundImage:
          "radial-gradient(circle, var(--color-border) 1px, transparent 1px)",
        backgroundSize: `${20 * viewport.zoom}px ${20 * viewport.zoom}px`,
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
      }}
      onWheel={onWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onContextMenu={handleContextMenu}
      onClick={handleCanvasClick}
      onDoubleClick={handleDoubleClick}
    >
      <div
        data-canvas-background
        className="absolute inset-0 origin-top-left"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
        }}
      >
        {visibleCards.map((card) => (
          <CardShell
            key={card.id}
            card={card}
            selected={selectedCardIds.has(card.id)}
          >
            <CardContent card={card} />
          </CardShell>
        ))}
      </div>

      {selectionBox && (
        <div
          className="pointer-events-none absolute border border-blue-500 bg-blue-500/10"
          style={{
            left: selectionBox.x,
            top: selectionBox.y,
            width: selectionBox.width,
            height: selectionBox.height,
          }}
        />
      )}

      {!currentProjectId && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-lg text-muted-foreground">
            请创建或选择一个项目开始
          </p>
        </div>
      )}

      <ZoomControls zoom={viewport.zoom} />

      {quickMenu && currentProjectId && (
        <QuickCreateMenu
          position={quickMenu}
          projectId={currentProjectId}
          onClose={closeQuickMenu}
        />
      )}

      <FloatingEditor />
    </div>
  );
}
