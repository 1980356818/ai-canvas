import { useRef, useState, useCallback, useEffect } from "react";
import { useCanvasStore, lastPointerWorld } from "@/stores/canvasStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useViewport } from "./hooks/useViewport";
import { useSelection } from "./hooks/useSelection";
import { useSpatialIndex } from "./hooks/useSpatialIndex";
import { useBirdView } from "./hooks/useBirdView";
import { useFileDrop } from "@/hooks/useFileDrop";
import CardLayer from "./CardLayer";
import GroupLayer from "./GroupLayer";
import FloatingEditor from "@/features/editor/FloatingEditor";
import ConnectionLayer from "./ConnectionLayer";
import CanvasBirdView from "./CanvasBirdView";
import ZoomControls from "./ZoomControls";
import ImageToolbar from "./ImageToolbar";
import VideoToolbar from "./VideoToolbar";
import WireDropMenu from "./WireDropMenu";

export default function CanvasContainer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    viewport,
    isPanning,
    onWheel,
    onPointerDown: vpPointerDown,
    onPointerMove: vpPointerMove,
    onPointerUp: vpPointerUp,
    startPan,
    screenToCanvas,
  } = useViewport(containerRef);

  const {
    selectionBox,
    onCanvasPointerMove,
    finishSelection,
    startSelection,
  } = useSelection(containerRef);

  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const showContextMenu = useUIStore((s) => s.showContextMenu);
  const pickMode = useCanvasStore((s) => s.pickMode);

  useSpatialIndex();

  const { isBirdView, showDom, showCanvas, transitioning } = useBirdView(viewport.zoom);
  const { handleDragOver, handleDragLeave, handleDrop } = useFileDrop(containerRef, screenToCanvas);

  useEffect(() => {
    if (!pickMode?.active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useCanvasStore.getState().exitPickMode();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickMode?.active]);

  // Space key + box selection + panning interaction
  const spaceHeld = useRef(false);
  const bgPending = useRef(false);
  const bgMode = useRef<"none" | "selecting" | "panning">("none");
  const justBoxSelected = useRef(false);
  const bgStart = useRef({ x: 0, y: 0 });
  const [spaceDown, setSpaceDown] = useState(false);

  useEffect(() => {
    const isFocusOnInput = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat) {
        // IME 合成中（中文输入法靠 Space 上屏）或焦点在输入框时，不拦截 Space。
        if (e.isComposing || e.keyCode === 229 || isFocusOnInput()) return;
        e.preventDefault();
        spaceHeld.current = true;
        setSpaceDown(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceHeld.current = false;
        setSpaceDown(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    vpPointerDown(e);

    const target = e.target as HTMLElement;
    const isCanvasBg =
      target === containerRef.current ||
      target.dataset.canvasBackground !== undefined;

    if (isCanvasBg && e.button === 0) {
      if (spaceHeld.current) {
        bgPending.current = true;
        bgMode.current = "none";
        bgStart.current = { x: e.clientX, y: e.clientY };
      } else {
        bgMode.current = "panning";
        bgPending.current = false;
        startPan(e.clientX, e.clientY);
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const world = screenToCanvas(e.clientX, e.clientY);
    lastPointerWorld.x = world.x;
    lastPointerWorld.y = world.y;

    if (bgPending.current) {
      const dx = e.clientX - bgStart.current.x;
      const dy = e.clientY - bgStart.current.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        bgPending.current = false;
        bgMode.current = "selecting";
        startSelection(bgStart.current.x, bgStart.current.y);
      }
    }

    if (bgMode.current === "panning") {
      vpPointerMove(e);
    } else if (bgMode.current === "selecting") {
      onCanvasPointerMove(e);
    } else {
      vpPointerMove(e);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    const wasPending = bgPending.current;
    bgPending.current = false;

    if (bgMode.current === "panning") {
      vpPointerUp();
    } else if (bgMode.current === "selecting") {
      finishSelection(e.clientX, e.clientY, e.ctrlKey || e.metaKey);
      justBoxSelected.current = true;
    } else if (wasPending) {
      useCanvasStore.getState().clearSelection();
    }
    bgMode.current = "none";
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const world = screenToCanvas(e.clientX, e.clientY);
    showContextMenu(e.clientX, e.clientY, "canvas", undefined, world.x, world.y);
  };

  const handleCanvasClick = (e: React.MouseEvent) => {
    if (justBoxSelected.current) {
      justBoxSelected.current = false;
      return;
    }
    if (
      e.target === containerRef.current ||
      (e.target as HTMLElement).dataset.canvasBackground !== undefined
    ) {
      if (useCanvasStore.getState().pickMode?.active) {
        useCanvasStore.getState().exitPickMode();
        return;
      }
      useCanvasStore.getState().clearSelection();
      useConnectionStore.getState().setSelectedConnectionId(null);
    }
  };

  const handleConnectionContextMenu = useCallback(
    (e: React.MouseEvent, connectionId: string) => {
      showContextMenu(e.clientX, e.clientY, "connection", connectionId);
    },
    [showContextMenu],
  );

  const handleDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const isCanvasBg =
      target === containerRef.current ||
      target.dataset.canvasBackground !== undefined;
    if (!isCanvasBg) return;
    const world = screenToCanvas(e.clientX, e.clientY);
    showContextMenu(e.clientX, e.clientY, "canvas", undefined, world.x, world.y);
  };

  return (
    <div
      ref={containerRef}
      data-canvas-viewport
      className="relative flex-1 overflow-hidden bg-background"
      style={{
        cursor: isPanning ? "grabbing" : spaceDown ? "crosshair" : "default",
      }}
      onWheel={onWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onContextMenu={handleContextMenu}
      onClick={handleCanvasClick}
      onDoubleClick={handleDoubleClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {showCanvas && (
        <div
          className="absolute inset-0"
          style={{
            opacity: isBirdView ? 1 : 0,
            transition: transitioning ? "opacity 200ms ease" : "none",
            pointerEvents: isBirdView ? "auto" : "none",
            zIndex: isBirdView ? 1 : 0,
          }}
        >
          <CanvasBirdView viewport={viewport} screenToCanvas={screenToCanvas} />
        </div>
      )}

      {showDom && (
        <div
          data-canvas-background
          className="absolute inset-0 origin-top-left"
          style={{
            // 始终引用 CSS 变量，渲染字符串永不变化，避免 React commit 与
            // useViewport 的 imperative DOM 写入冲突而打破 GPU 合成层。
            transform:
              "translate3d(var(--vp-x, 0px), var(--vp-y, 0px), 0) scale(var(--vp-zoom, 1))",
            opacity: isBirdView ? 0 : 1,
            transition: transitioning ? "opacity 200ms ease" : "none",
            pointerEvents: isBirdView ? "none" : "auto",
          }}
        >
          {/*
           * GroupLayer 渲染在 CardLayer 之前(DOM 顺序 = 绘制顺序),
           * 组矩形在卡片下方;组矩形 body 设 pointer-events:none,只在标题栏
           * 接事件,保证点中组区域内的卡片仍能被命中。
           */}
          <GroupLayer projectId={currentProjectId} viewport={viewport} />

          <CardLayer projectId={currentProjectId} viewport={viewport} />

          {currentProjectId && (
            <ConnectionLayer
              projectId={currentProjectId}
              viewport={viewport}
              onConnectionContextMenu={handleConnectionContextMenu}
            />
          )}
        </div>
      )}

      {pickMode?.active && (
        <div className="pointer-events-none absolute left-1/2 top-4 z-50 -translate-x-1/2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-medium text-primary backdrop-blur-sm">
          点击一个含图片的卡片以选取为参考图 · 按 Esc 取消
        </div>
      )}

      {selectionBox && (
        <div
          className="pointer-events-none fixed z-50 border border-blue-500 bg-blue-500/10"
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

      <WireDropMenu />

      {!isBirdView && <ImageToolbar />}
      {!isBirdView && <VideoToolbar />}

      <ZoomControls zoom={viewport.zoom} />

      {!isBirdView && <FloatingEditor />}

      {isBirdView && (
        <div className="pointer-events-none absolute bottom-14 left-1/2 z-40 -translate-x-1/2 rounded-lg border border-border/40 bg-card/80 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur-sm">
          鸟瞰模式 · 滚轮放大可切回编辑
        </div>
      )}
    </div>
  );
}
