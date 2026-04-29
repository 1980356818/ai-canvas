import { useState, useEffect, useLayoutEffect, useCallback, useRef, memo } from "react";
import { Scissors, Crop, Download, ChevronDown, HardDriveDownload, Loader2, ZoomIn, RotateCw } from "lucide-react";
import { useCanvasStore, liveViewport, subscribeViewport } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard, Connection } from "@/types";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { persistImage, getDisplayUrl, exportFile } from "@/lib/media";
import { cropImageCell } from "@/lib/cropImage";
import { autoSave } from "@/lib/autoSave";
import { sizeFromRatio } from "@/shared/constants";
import { updateProjectMeta } from "@/platform";
import { HIDDEN_FEATURES } from "@/config/platforms";
import { cn } from "@/lib/utils";

const GRID_OPTIONS = [
  { size: 2, label: "2×2" },
  { size: 3, label: "3×3" },
  { size: 4, label: "4×4" },
  { size: 5, label: "5×5" },
];

const TOOLBAR_GAP = 10;

function screenToCanvas(clientX: number, clientY: number) {
  const container = document.querySelector("[data-canvas-viewport]");
  const rect = container?.getBoundingClientRect();
  const vp = useCanvasStore.getState().viewport;
  const x = rect ? clientX - rect.left : clientX;
  const y = rect ? clientY - rect.top : clientY;
  return {
    x: (x - vp.x) / vp.zoom,
    y: (y - vp.y) / vp.zoom,
  };
}

interface CellDragInfo {
  row: number;
  col: number;
  clientX: number;
  clientY: number;
}

interface GridOverlayProps {
  cardId: string;
  gridSize: number;
  onCellDrop: (info: CellDragInfo) => void;
  disabled: boolean;
  // 由父级共享的 ref，imperative 同步 left/top/width/height/borderRadius，
  // 避免 GridOverlay 在 viewport / dragOffset 变化时重渲染。
  overlayRef: React.RefObject<HTMLDivElement | null>;
}

const GridOverlay = memo(function GridOverlay({
  cardId,
  gridSize,
  onCellDrop,
  disabled,
  overlayRef,
}: GridOverlayProps) {
  const [hoveredCell, setHoveredCell] = useState<{
    row: number;
    col: number;
  } | null>(null);

  const [dragging, setDragging] = useState<{
    row: number;
    col: number;
    cx: number;
    cy: number;
  } | null>(null);

  const draggingFloatRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef(dragging);
  dragRef.current = dragging;

  const cellPercent = 100 / gridSize;

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, row: number, col: number) => {
      if (disabled) return;
      e.stopPropagation();
      e.preventDefault();
      setDragging({ row, col, cx: e.clientX, cy: e.clientY });

      const onMove = (ev: PointerEvent) => {
        // imperative 移动浮动框，避免 setState 触发重渲染
        const fl = draggingFloatRef.current;
        const ov = overlayRef.current;
        if (fl && ov) {
          const cellW = ov.offsetWidth / gridSize;
          const cellH = ov.offsetHeight / gridSize;
          fl.style.left = `${ev.clientX - cellW / 2}px`;
          fl.style.top = `${ev.clientY - cellH / 2}px`;
          fl.style.width = `${cellW}px`;
          fl.style.height = `${cellH}px`;
        }
        // 同步坐标到 ref（onUp 时使用）
        const cur = dragRef.current;
        if (cur) dragRef.current = { ...cur, cx: ev.clientX, cy: ev.clientY };
      };

      const onUp = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);

        const blockClick = (ce: Event) => {
          ce.stopPropagation();
          ce.stopImmediatePropagation();
          ce.preventDefault();
        };
        window.addEventListener("click", blockClick, { capture: true, once: true });
        const cleanupTimer = setTimeout(
          () => window.removeEventListener("click", blockClick, { capture: true }),
          200,
        );

        const cur = dragRef.current;
        if (cur) {
          onCellDrop({ row: cur.row, col: cur.col, clientX: ev.clientX, clientY: ev.clientY });
        }
        setDragging(null);
        void cleanupTimer;
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [disabled, gridSize, onCellDrop, overlayRef],
  );

  // 浮动框初始位置：拖拽刚开始时设置一次（之后由 onMove imperative 更新）
  useLayoutEffect(() => {
    if (!dragging) return;
    const fl = draggingFloatRef.current;
    const ov = overlayRef.current;
    if (!fl || !ov) return;
    const cellW = ov.offsetWidth / gridSize;
    const cellH = ov.offsetHeight / gridSize;
    fl.style.left = `${dragging.cx - cellW / 2}px`;
    fl.style.top = `${dragging.cy - cellH / 2}px`;
    fl.style.width = `${cellW}px`;
    fl.style.height = `${cellH}px`;
  }, [dragging, gridSize, overlayRef]);

  const cells = [];
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      const isHovered = hoveredCell?.row === r && hoveredCell?.col === c;
      const isDraggingThis = dragging?.row === r && dragging?.col === c;
      cells.push(
        <div
          key={`${r}-${c}`}
          className={cn(
            "absolute transition-all duration-150",
            disabled
              ? "cursor-wait"
              : "cursor-crosshair",
            isHovered && !isDraggingThis
              ? "crop-cell-hover z-10"
              : "crop-cell-idle",
            isDraggingThis && "opacity-40",
          )}
          // 使用百分比定位：尺寸完全独立于 zoom，无需在 viewport 变化时重渲染
          style={{
            left: `${c * cellPercent}%`,
            top: `${r * cellPercent}%`,
            width: `${cellPercent}%`,
            height: `${cellPercent}%`,
          }}
          onPointerEnter={() => setHoveredCell({ row: r, col: c })}
          onPointerLeave={() => setHoveredCell(null)}
          onPointerDown={(e) => handlePointerDown(e, r, c)}
        >
          {isHovered && !dragging && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="rounded-md bg-black/60 px-2 py-1 text-[10px] font-medium text-white shadow-lg backdrop-blur-sm">
                拖拽提取
              </div>
            </div>
          )}
        </div>,
      );
    }
  }

  // 标记便于父组件 imperative 寻找此 overlay（cardId 仅用于调试 / 数据语义）
  return (
    <>
      <div
        ref={overlayRef}
        data-card-id={cardId}
        className="crop-overlay absolute z-40 overflow-hidden"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="pointer-events-none absolute inset-0 bg-black/20" />
        {cells}
      </div>

      {dragging && (
        <div
          ref={draggingFloatRef}
          className="pointer-events-none fixed z-[9999] rounded-lg border-2 border-primary bg-primary/10 shadow-xl backdrop-blur-sm"
        >
          <div className="flex h-full items-center justify-center text-xs font-medium text-primary">
            释放放置
          </div>
        </div>
      )}
    </>
  );
});

export default function ImageToolbar() {
  const editingCardId = useCanvasStore((s) => s.editingCardId);
  const selectedCardIds = useCanvasStore((s) => s.selectedCardIds);

  const targetCardId =
    editingCardId ??
    (selectedCardIds.size === 1
      ? Array.from(selectedCardIds)[0]
      : undefined);

  const card = useCardStore((s) =>
    targetCardId ? s.cards.get(targetCardId) : undefined,
  );

  const [activeGrid, setActiveGrid] = useState<number | null>(null);
  const [cropping, setCropping] = useState(false);
  const gridCardId = useRef<string | null>(null);

  // imperative 跟随：toolbar 容器和 grid overlay 的位置由 ref + rAF 同步，
  // 不参与 React 渲染。这样 viewport / dragOffset 高频变化都不会触发本组件重渲染。
  const toolbarRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const scheduleSyncRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    if (!targetCardId) {
      scheduleSyncRef.current = null;
      return;
    }

    let rafId = 0;
    let scheduled = false;
    let prevSig = "";

    const sync = () => {
      scheduled = false;
      const c = useCardStore.getState().cards.get(targetCardId);
      if (!c) return;
      const vp = liveViewport;
      const off = useCanvasStore.getState().dragOffsets.get(targetCardId);
      const offDx = off ? off.dx * vp.zoom : 0;
      const offDy = off ? off.dy * vp.zoom : 0;
      const left = c.x * vp.zoom + vp.x + offDx;
      const top = c.y * vp.zoom + vp.y + offDy;
      const width = c.width * vp.zoom;
      const height = c.height * vp.zoom;
      const sig = `${left}|${top}|${width}|${height}`;
      if (sig === prevSig) return;
      prevSig = sig;

      const tb = toolbarRef.current;
      if (tb) {
        tb.style.left = `${left + width / 2}px`;
        tb.style.top = `${top - TOOLBAR_GAP}px`;
      }
      const ov = overlayRef.current;
      if (ov) {
        ov.style.left = `${left}px`;
        ov.style.top = `${top}px`;
        ov.style.width = `${width}px`;
        ov.style.height = `${height}px`;
        ov.style.borderRadius = `${12 * vp.zoom}px`;
      }
    };

    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      rafId = requestAnimationFrame(sync);
    };

    scheduleSyncRef.current = schedule;
    sync();

    const unsubVp = subscribeViewport(schedule);
    const unsubCanvas = useCanvasStore.subscribe((s, prev) => {
      if (s.dragOffsets !== prev.dragOffsets) schedule();
    });
    const unsubCards = useCardStore.subscribe((s, prev) => {
      if (s.cards !== prev.cards) schedule();
    });

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      unsubVp();
      unsubCanvas();
      unsubCards();
      scheduleSyncRef.current = null;
    };
  }, [targetCardId]);

  // GridOverlay 挂载/卸载后立刻同步一次位置（overlayRef.current 此时刚就绪）
  useLayoutEffect(() => {
    scheduleSyncRef.current?.();
  }, [activeGrid]);

  useEffect(() => {
    if (activeGrid && gridCardId.current && targetCardId !== gridCardId.current) {
      setActiveGrid(null);
      gridCardId.current = null;
    }
  }, [targetCardId, activeGrid]);

  const handleCellDrop = useCallback(
    async (info: CellDragInfo) => {
      if (!card || !activeGrid || cropping) return;
      const data = card.data as { imageUrl?: string };
      if (!data.imageUrl) return;

      setCropping(true);
      try {
        const { dataUrl } = await cropImageCell(
          data.imageUrl,
          info.row,
          info.col,
          activeGrid,
        );
        const projectId = useProjectStore.getState().currentProjectId;
        if (!projectId) return;

        const { localPath: relativePath } = await persistImage(dataUrl, undefined, projectId);

        const cardRatio = card.width / card.height;
        const { width: newW, height: newH } = sizeFromRatio(cardRatio);

        const { maxZIndex } = useCardStore.getState();

        const dropPos = screenToCanvas(info.clientX, info.clientY);

        const now = new Date().toISOString();
        const newCard: CanvasCard = {
          id: crypto.randomUUID(),
          projectId,
          type: "ai_image",
          x: dropPos.x - newW / 2,
          y: dropPos.y - newH / 2,
          width: newW,
          height: newH,
          zIndex: maxZIndex + 1,
          locked: false,
          collapsed: false,
          data: { imageUrl: relativePath, content: "" },
          createdAt: now,
          updatedAt: now,
        };

        useCardStore.getState().addCard(newCard);
        autoSave.markDirty(newCard.id);

        useCanvasStore.getState().setSelectedCardIds([card.id]);

        const count = useCardStore
          .getState()
          .getCardsByProject(projectId).length;
        useProjectStore
          .getState()
          .updateProject(projectId, { nodeCount: count });
        void updateProjectMeta(projectId, { nodeCount: count });
      } catch (err) {
        useUIStore.getState().addToast({
          type: "error",
          title: "裁剪失败",
          description: String(err),
          duration: 3000,
        });
      } finally {
        setCropping(false);
      }
    },
    [card, activeGrid, cropping],
  );

  const [gridDropdownOpen, setGridDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!gridDropdownOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (dropdownRef.current?.contains(e.target as Node)) return;
      setGridDropdownOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [gridDropdownOpen]);

  const handleDownload = useCallback(async () => {
    if (!card) return;
    const data = card.data as { imageUrl?: string; content?: string };
    if (!data.imageUrl) return;
    if (data.imageUrl.startsWith("data:") || data.imageUrl.startsWith("http")) {
      useUIStore.getState().addToast({ type: "info", title: "该图片暂不支持直接下载", duration: 2500 });
      return;
    }
    try {
      const pid = useProjectStore.getState().currentProjectId ?? undefined;
      await exportFile(data.imageUrl, (data.content as string) || "AI图片", pid);
      useUIStore.getState().addToast({ type: "success", title: "图片已导出", duration: 3000 });
    } catch (err) {
      useUIStore.getState().addToast({ type: "error", title: "导出失败", description: String(err), duration: 5000 });
    }
  }, [card]);

  const [saving, setSaving] = useState(false);

  const isRemoteUrl = useCallback((url?: string) => {
    return !!url && (url.startsWith("http://") || url.startsWith("https://"));
  }, []);

  const handleSaveLocal = useCallback(async () => {
    if (!card || saving) return;
    const data = card.data as { imageUrl?: string };
    if (!data.imageUrl || !isRemoteUrl(data.imageUrl)) return;

    setSaving(true);
    try {
      const projectId = useProjectStore.getState().currentProjectId ?? undefined;
      const { localPath } = await persistImage(data.imageUrl, card.title || undefined, projectId);
      useCardStore.getState().updateCard(card.id, {
        data: { ...card.data, imageUrl: localPath },
      });
      autoSave.markDirty(card.id);
      useUIStore.getState().addToast({ type: "success", title: "图片已保存到本地", duration: 2500 });
    } catch (err) {
      useUIStore.getState().addToast({
        type: "error",
        title: "保存失败",
        description: String(err),
        duration: 5000,
      });
    } finally {
      setSaving(false);
    }
  }, [card, saving, isRemoteUrl]);

  const handleUpscale = useCallback(() => {
    if (!card) return;
    const imgData = card.data as { imageUrl?: string };
    if (!imgData.imageUrl) return;

    const projectId = useProjectStore.getState().currentProjectId;
    if (!projectId) return;

    const { maxZIndex } = useCardStore.getState();
    const now = new Date().toISOString();
    const GAP = 80;

    const newCard: CanvasCard = {
      id: crypto.randomUUID(),
      projectId,
      type: "ai_image",
      x: card.x + card.width + GAP,
      y: card.y,
      width: card.width,
      height: card.height,
      zIndex: maxZIndex + 1,
      locked: false,
      collapsed: false,
      data: {
        content: "",
        model: useSettingsStore.getState().getLastModel("enhancer")?.modelId || "SeedVR2-Upscaler",
        provider: useSettingsStore.getState().getLastModel("enhancer")?.providerId || "comfly",
      },
      createdAt: now,
      updatedAt: now,
    };
    useCardStore.getState().addCard(newCard);

    const conn: Connection = {
      id: crypto.randomUUID(),
      projectId,
      sourceCardId: card.id,
      targetCardId: newCard.id,
      createdAt: now,
    };
    useConnectionStore.getState().addConnection(conn);

    useCanvasStore.getState().setSelectedCardIds([newCard.id]);
    useCanvasStore.getState().setEditingCardId(newCard.id);

    autoSave.markDirty(newCard.id);
    const count = useCardStore.getState().getCardsByProject(projectId).length;
    useProjectStore.getState().updateProject(projectId, { nodeCount: count });
    void updateProjectMeta(projectId, { nodeCount: count });
  }, [card]);

  const handleMultiangle = useCallback(() => {
    if (!card) return;
    const imgData = card.data as { imageUrl?: string };
    if (!imgData.imageUrl) return;

    const projectId = useProjectStore.getState().currentProjectId;
    if (!projectId) return;

    const { maxZIndex } = useCardStore.getState();
    const now = new Date().toISOString();
    const GAP = 80;

    const newCard: CanvasCard = {
      id: crypto.randomUUID(),
      projectId,
      type: "ai_multiangle",
      x: card.x + card.width + GAP,
      y: card.y,
      width: card.width,
      height: card.width,
      zIndex: maxZIndex + 1,
      locked: false,
      collapsed: false,
      data: {
        content: "h:0,v:0,z:5",
        model: useSettingsStore.getState().getLastModel("multiangle")?.modelId || "qwen-image-edit-2511-multipie",
        provider: useSettingsStore.getState().getLastModel("multiangle")?.providerId || "comfly",
        size: "1:1",
        h: 0,
        v: 0,
        z: 5,
      },
      createdAt: now,
      updatedAt: now,
    };
    useCardStore.getState().addCard(newCard);

    const conn: Connection = {
      id: crypto.randomUUID(),
      projectId,
      sourceCardId: card.id,
      targetCardId: newCard.id,
      createdAt: now,
    };
    useConnectionStore.getState().addConnection(conn);

    useCanvasStore.getState().setSelectedCardIds([newCard.id]);
    useCanvasStore.getState().setEditingCardId(newCard.id);

    autoSave.markDirty(newCard.id);
    const count = useCardStore.getState().getCardsByProject(projectId).length;
    useProjectStore.getState().updateProject(projectId, { nodeCount: count });
    void updateProjectMeta(projectId, { nodeCount: count });
  }, [card]);

  if (!card || (card.type !== "ai_image" && card.type !== "ai_multiangle")) return null;
  const imgData = card.data as { imageUrl?: string };
  if (!imgData.imageUrl) return null;

  const showSaveLocal = isRemoteUrl(imgData.imageUrl);

  const activeLabel = GRID_OPTIONS.find((o) => o.size === activeGrid)?.label;

  return (
    <>
      <div
        ref={toolbarRef}
        className="absolute z-50"
        // left/top 由上方 useLayoutEffect 通过 ref imperative 设置
        style={{
          transform: "translateX(-50%) translateY(-100%)",
        }}
      >
      <div
        className="image-toolbar flex items-center gap-1 rounded-lg border border-border/60 bg-card/95 px-2 py-1 shadow-xl backdrop-blur-md"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Grid split dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            title="宫格拆分"
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
              activeGrid
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
            onClick={() => setGridDropdownOpen((v) => !v)}
          >
            <Scissors className="h-3.5 w-3.5" />
            <span>{activeGrid ? `宫格拆分 ${activeLabel}` : "宫格拆分"}</span>
            <ChevronDown className="h-3 w-3" />
          </button>

          {gridDropdownOpen && (
            <div className="absolute left-1/2 top-full z-50 mt-1 -translate-x-1/2 rounded-lg border border-border bg-popover p-1 shadow-lg">
              {GRID_OPTIONS.map(({ size, label }) => (
                <button
                  key={size}
                  className={cn(
                    "flex w-full items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                    activeGrid === size
                      ? "bg-primary text-primary-foreground"
                      : "text-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                  onClick={() => {
                    if (activeGrid === size) {
                      setActiveGrid(null);
                      gridCardId.current = null;
                    } else {
                      setActiveGrid(size);
                      gridCardId.current = targetCardId ?? null;
                    }
                    setGridDropdownOpen(false);
                  }}
                >
                  {label} 宫格
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Free crop → open dialog */}
        <button
          title="自由裁剪"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => {
            if (!imgData.imageUrl || !targetCardId) return;
            useUIStore.getState().openCropDialog(
              imgData.imageUrl,
              getDisplayUrl(imgData.imageUrl),
              targetCardId,
            );
          }}
        >
          <Crop className="h-3.5 w-3.5" />
          <span>裁剪</span>
        </button>

        {(!HIDDEN_FEATURES.upscale || !HIDDEN_FEATURES.multiangle) && (
          <div className="mx-0.5 h-4 w-px bg-border" />
        )}

        {!HIDDEN_FEATURES.upscale && (
          <button
            title="高清放大"
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={handleUpscale}
          >
            <ZoomIn className="h-3.5 w-3.5" />
            <span>高清放大</span>
          </button>
        )}

        {!HIDDEN_FEATURES.multiangle && (
          <button
            title="多角度"
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={handleMultiangle}
          >
            <RotateCw className="h-3.5 w-3.5" />
            <span>多角度</span>
          </button>
        )}

        <div className="mx-0.5 h-4 w-px bg-border" />

        {showSaveLocal && (
          <>
            <button
              title="保存到本地"
              disabled={saving}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                "bg-amber-500/15 text-amber-600 hover:bg-amber-500/25 dark:text-amber-400",
                saving && "cursor-not-allowed opacity-60",
              )}
              onClick={() => void handleSaveLocal()}
            >
              {saving
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <HardDriveDownload className="h-3.5 w-3.5" />
              }
              <span>{saving ? "保存中…" : "保存到本地"}</span>
            </button>
            <div className="mx-0.5 h-4 w-px bg-border" />
          </>
        )}

        {/* Download button */}
        <button
          title="下载图片"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => void handleDownload()}
        >
          <Download className="h-3.5 w-3.5" />
          <span>下载</span>
        </button>
      </div>
      </div>

      {activeGrid && targetCardId && (
        <GridOverlay
          cardId={targetCardId}
          gridSize={activeGrid}
          onCellDrop={handleCellDrop}
          disabled={cropping}
          overlayRef={overlayRef}
        />
      )}

    </>
  );
}
