import { useRef, useState, useCallback, useEffect } from "react";
import { useCanvasStore, lastPointerWorld } from "@/stores/canvasStore";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useViewport } from "./hooks/useViewport";
import { useSelection } from "./hooks/useSelection";
import { useSpatialIndex } from "./hooks/useSpatialIndex";
import CardLayer from "./CardLayer";
import FloatingEditor from "@/features/editor/FloatingEditor";
import ConnectionLayer from "./ConnectionLayer";
import CanvasBirdView from "./CanvasBirdView";
import ZoomControls from "./ZoomControls";
import ImageToolbar from "./ImageToolbar";
import { CARD_DEFAULTS, sizeFromRatio, BIRDVIEW_ENTER_ZOOM, BIRDVIEW_EXIT_ZOOM } from "@/shared/constants";
import { autoSave } from "@/lib/autoSave";
import {
  updateProjectMeta,
  onTauriFileDrop,
  isTauri,
} from "@/lib/tauri";
import { persistImage, type PersistImageResult } from "@/lib/media";

function cardSizeFromPersist(
  saved: PersistImageResult,
): { width: number; height: number } {
  if (saved.width && saved.height && saved.width > 0 && saved.height > 0) {
    return sizeFromRatio(saved.width / saved.height);
  }
  return { width: CARD_DEFAULTS.ai_image.width, height: CARD_DEFAULTS.ai_image.height };
}

function canCardAcceptFileDrop(cardId: string): boolean {
  const card = useCardStore.getState().getCard(cardId);
  if (!card) return false;
  if (useUIStore.getState().generatingCards.has(cardId)) return false;
  if (card.type === "ai_image" || card.type === "ai_multiangle") {
    return !(card.data as { imageUrl?: string }).imageUrl;
  }
  if (card.type === "ai_tryon") {
    const d = card.data as {
      personImageUrl?: string;
      garmentImageUrl?: string;
    };
    return !d.personImageUrl || !d.garmentImageUrl;
  }
  return false;
}


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

  const [birdView, setBirdView] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const transTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTarget = useRef<boolean | null>(null);

  const shouldBird = birdView
    ? viewport.zoom < BIRDVIEW_EXIT_ZOOM
    : viewport.zoom <= BIRDVIEW_ENTER_ZOOM;

  if (shouldBird !== birdView && !transitioning) {
    pendingTarget.current = shouldBird;
    setTransitioning(true);
    if (transTimer.current) clearTimeout(transTimer.current);
    transTimer.current = setTimeout(() => {
      transTimer.current = null;
      setBirdView(pendingTarget.current!);
      pendingTarget.current = null;
      setTimeout(() => setTransitioning(false), 50);
    }, 200);
  } else if (shouldBird === birdView && transitioning && pendingTarget.current !== null) {
    if (transTimer.current) clearTimeout(transTimer.current);
    transTimer.current = null;
    pendingTarget.current = null;
    setTransitioning(false);
  }

  const isBirdView = birdView;
  const showDom = !birdView || transitioning;
  const showCanvas = birdView || transitioning;


  const dropHandledAt = useRef(0);
  const fileDragTargetRef = useRef<string | null>(null);

  const handleFileDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!currentProjectId) return;
      const hasFiles = Array.from(e.dataTransfer.types).includes("Files");
      if (!hasFiles) return;
      e.preventDefault();

      const el = document.elementFromPoint(e.clientX, e.clientY);
      const cardEl = el?.closest("[data-card-id]") as HTMLElement | null;
      const candidateId = cardEl?.dataset.cardId ?? null;
      const newTargetId =
        candidateId && canCardAcceptFileDrop(candidateId) ? candidateId : null;

      if (newTargetId !== fileDragTargetRef.current) {
        if (fileDragTargetRef.current) {
          document
            .querySelector(
              `[data-card-id="${fileDragTargetRef.current}"]`,
            )
            ?.classList.remove("file-drop-target");
        }
        fileDragTargetRef.current = newTargetId;
        if (newTargetId) {
          document
            .querySelector(`[data-card-id="${newTargetId}"]`)
            ?.classList.add("file-drop-target");
        }
      }

      e.dataTransfer.dropEffect = newTargetId ? "move" : "copy";
    },
    [currentProjectId],
  );

  const handleFileDragLeave = useCallback(
    (e: React.DragEvent) => {
      const related = e.relatedTarget as Node | null;
      if (related && containerRef.current?.contains(related)) return;
      if (fileDragTargetRef.current) {
        document
          .querySelector(
            `[data-card-id="${fileDragTargetRef.current}"]`,
          )
          ?.classList.remove("file-drop-target");
        fileDragTargetRef.current = null;
      }
    },
    [],
  );

  const handleFileDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!currentProjectId) return;

      const files = Array.from(e.dataTransfer.files).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (files.length === 0) return;

      dropHandledAt.current = Date.now();

      const targetCardId = fileDragTargetRef.current;
      if (fileDragTargetRef.current) {
        document
          .querySelector(
            `[data-card-id="${fileDragTargetRef.current}"]`,
          )
          ?.classList.remove("file-drop-target");
        fileDragTargetRef.current = null;
      }

      const readFileAsDataUrl = (file: File): Promise<string> =>
        new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(file);
        });

      (async () => {
        let startIdx = 0;

        if (targetCardId) {
          const targetCard = useCardStore.getState().getCard(targetCardId);
          if (targetCard) {
            const dataUrl = await readFileAsDataUrl(files[0]!);
            const saved = await persistImage(dataUrl, undefined, currentProjectId);
            const latest = useCardStore.getState().getCard(targetCardId);
            if (latest) {
              const d = { ...latest.data } as Record<string, unknown>;
              const update: Partial<CanvasCard> = { data: d };
              if (latest.type === "ai_image" || latest.type === "ai_multiangle") {
                d.imageUrl = saved.localPath;
                const sized = cardSizeFromPersist(saved);
                const cx = latest.x + latest.width / 2;
                const cy = latest.y + latest.height / 2;
                update.x = cx - sized.width / 2;
                update.y = cy - sized.height / 2;
                update.width = sized.width;
                update.height = sized.height;
              } else if (latest.type === "ai_tryon") {
                if (!d.personImageUrl) d.personImageUrl = saved.localPath;
                else if (!d.garmentImageUrl) d.garmentImageUrl = saved.localPath;
              }
              useCardStore.getState().updateCard(targetCardId, update);
              autoSave.markDirty(targetCardId);
            }
            startIdx = 1;
          }
        }

        const remaining = files.slice(startIdx);
        if (remaining.length === 0) return;

        const dropPos = screenToCanvas(e.clientX, e.clientY);
        const GAP = 20;
        let cursorX = 0;

        for (let idx = 0; idx < remaining.length; idx++) {
          const dataUrl = await readFileAsDataUrl(remaining[idx]!);
          const saved = await persistImage(dataUrl, undefined, currentProjectId);
          const { width: cardW, height: cardH } = cardSizeFromPersist(saved);

          const now = new Date().toISOString();
          const { maxZIndex } = useCardStore.getState();
          const card: CanvasCard = {
            id: crypto.randomUUID(),
            projectId: currentProjectId,
            type: "ai_image",
            x: dropPos.x - cardW / 2 + cursorX,
            y: dropPos.y - cardH / 2,
            width: cardW,
            height: cardH,
            zIndex: maxZIndex + 1 + idx,
            locked: false,
            collapsed: false,
            data: { imageUrl: saved.localPath, content: "" },
            createdAt: now,
            updatedAt: now,
          };
          useCardStore.getState().addCard(card);
          autoSave.markDirty(card.id);
          cursorX += cardW + GAP;
        }

        const count = useCardStore.getState().getCardsByProject(currentProjectId).length;
        useProjectStore
          .getState()
          .updateProject(currentProjectId, { nodeCount: count });
        void updateProjectMeta(currentProjectId, { nodeCount: count });
      })();
    },
    [currentProjectId, screenToCanvas],
  );

  useEffect(() => {
    if (!pickMode?.active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useCanvasStore.getState().exitPickMode();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickMode?.active]);

  // Tauri-native file-drop fallback (when browser drag events are intercepted)
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    onTauriFileDrop(async (paths, sx, sy) => {
      if (cancelled) return;
      if (Date.now() - dropHandledAt.current < 1000) return;
      const pid = useProjectStore.getState().currentProjectId;
      if (!pid) return;

      const dpr = window.devicePixelRatio || 1;
      const cssx = sx / dpr;
      const cssy = sy / dpr;
      const rect = containerRef.current?.getBoundingClientRect();
      const cx = rect ? cssx - rect.left : cssx;
      const cy = rect ? cssy - rect.top : cssy;
      const vp = useCanvasStore.getState().viewport;
      const dropX = (cx - vp.x) / vp.zoom;
      const dropY = (cy - vp.y) / vp.zoom;
      const GAP = 20;

      let startIdx = 0;
      const el = document.elementFromPoint(cssx, cssy);
      const cardEl = el?.closest("[data-card-id]") as HTMLElement | null;
      const targetCardId = cardEl?.dataset.cardId ?? null;

      if (targetCardId && canCardAcceptFileDrop(targetCardId)) {
        try {
          const saved = await persistImage(paths[0]!, undefined, pid);
          const target = useCardStore.getState().getCard(targetCardId);
          if (target) {
            const d = { ...target.data } as Record<string, unknown>;
            const update: Partial<CanvasCard> = { data: d };
            if (target.type === "ai_image" || target.type === "ai_multiangle") {
              d.imageUrl = saved.localPath;
              const sized = cardSizeFromPersist(saved);
              const cx = target.x + target.width / 2;
              const cy = target.y + target.height / 2;
              update.x = cx - sized.width / 2;
              update.y = cy - sized.height / 2;
              update.width = sized.width;
              update.height = sized.height;
            } else if (target.type === "ai_tryon") {
              if (!d.personImageUrl) d.personImageUrl = saved.localPath;
              else if (!d.garmentImageUrl) d.garmentImageUrl = saved.localPath;
            }
            useCardStore.getState().updateCard(targetCardId, update);
            autoSave.markDirty(targetCardId);
            startIdx = 1;
          }
        } catch { /* skip */ }
      }

      let tauriCursorX = 0;
      for (let i = startIdx; i < paths.length; i++) {
        try {
          const saved = await persistImage(paths[i]!, undefined, pid);
          const { width: cardW, height: cardH } = cardSizeFromPersist(saved);

          const now = new Date().toISOString();
          const { maxZIndex } = useCardStore.getState();
          const card: CanvasCard = {
            id: crypto.randomUUID(),
            projectId: pid,
            type: "ai_image",
            x: dropX - cardW / 2 + tauriCursorX,
            y: dropY - cardH / 2,
            width: cardW,
            height: cardH,
            zIndex: maxZIndex + 1 + (i - startIdx),
            locked: false,
            collapsed: false,
            data: { imageUrl: saved.localPath, content: "" },
            createdAt: now,
            updatedAt: now,
          };
          useCardStore.getState().addCard(card);
          autoSave.markDirty(card.id);
          tauriCursorX += cardW + GAP;
        } catch { /* skip unreadable files */ }
      }

      const count = useCardStore.getState().getCardsByProject(pid).length;
      useProjectStore.getState().updateProject(pid, { nodeCount: count });
      void updateProjectMeta(pid, { nodeCount: count });
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const spaceHeld = useRef(false);
  const bgPending = useRef(false);
  const bgMode = useRef<"none" | "selecting" | "panning">("none");
  const justBoxSelected = useRef(false);
  const bgStart = useRef({ x: 0, y: 0 });
  const [spaceDown, setSpaceDown] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat) {
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
      finishSelection(e.clientX, e.clientY, e.ctrlKey);
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
        backgroundImage: "radial-gradient(circle, var(--color-border) 1px, transparent 1px)",
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
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
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
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
            opacity: isBirdView ? 0 : 1,
            transition: transitioning ? "opacity 200ms ease" : "none",
            pointerEvents: isBirdView ? "none" : "auto",
          }}
        >
          <CardLayer projectId={currentProjectId} viewport={viewport} />

          {currentProjectId && (
            <ConnectionLayer
              projectId={currentProjectId}
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

      {!isBirdView && <ImageToolbar />}

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
