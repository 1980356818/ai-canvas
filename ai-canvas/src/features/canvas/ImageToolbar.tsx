import { useState, useEffect, useCallback, useRef, memo } from "react";
import { Scissors, Download, ChevronDown, HardDriveDownload, Loader2, ZoomIn } from "lucide-react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard, Connection } from "@/types";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { persistImage, getBase64ForApi, exportFile } from "@/lib/media";
import { autoSave } from "@/lib/autoSave";
import { injectOnConnect } from "@/lib/dataFlow";
import { sizeFromRatio } from "@/shared/constants";
import { updateProjectMeta } from "@/platform";
import { cn } from "@/lib/utils";

const GRID_OPTIONS = [
  { size: 2, label: "2×2" },
  { size: 3, label: "3×3" },
  { size: 4, label: "4×4" },
  { size: 5, label: "5×5" },
];

const TOOLBAR_GAP = 10;

async function cropImageCell(
  imageUrl: string,
  row: number,
  col: number,
  gridSize: number,
): Promise<{ dataUrl: string; cellW: number; cellH: number }> {
  const dataUrl = await getBase64ForApi(imageUrl);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const cellW = Math.floor(img.naturalWidth / gridSize);
        const cellH = Math.floor(img.naturalHeight / gridSize);
        const canvas = document.createElement("canvas");
        canvas.width = cellW;
        canvas.height = cellH;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(
          img,
          col * cellW,
          row * cellH,
          cellW,
          cellH,
          0,
          0,
          cellW,
          cellH,
        );
        resolve({ dataUrl: canvas.toDataURL("image/png"), cellW, cellH });
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = dataUrl;
  });
}

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

const GridOverlay = memo(function GridOverlay({
  card,
  gridSize,
  viewport,
  onCellDrop,
  disabled,
  dragOffset,
}: {
  card: CanvasCard;
  gridSize: number;
  viewport: { x: number; y: number; zoom: number };
  onCellDrop: (info: CellDragInfo) => void;
  disabled: boolean;
  dragOffset: { dx: number; dy: number } | null;
}) {
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

  const dragRef = useRef(dragging);
  dragRef.current = dragging;

  const zoom = viewport.zoom;
  const offsetDx = dragOffset ? dragOffset.dx * zoom : 0;
  const offsetDy = dragOffset ? dragOffset.dy * zoom : 0;
  const left = card.x * zoom + viewport.x + offsetDx;
  const top = card.y * zoom + viewport.y + offsetDy;
  const width = card.width * zoom;
  const height = card.height * zoom;
  const cellScreenW = width / gridSize;
  const cellScreenH = height / gridSize;

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, row: number, col: number) => {
      if (disabled) return;
      e.stopPropagation();
      e.preventDefault();
      setDragging({ row, col, cx: e.clientX, cy: e.clientY });

      const onMove = (ev: PointerEvent) => {
        setDragging((prev) =>
          prev ? { ...prev, cx: ev.clientX, cy: ev.clientY } : null,
        );
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
    [disabled, onCellDrop],
  );

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
          style={{
            left: c * cellScreenW,
            top: r * cellScreenH,
            width: cellScreenW,
            height: cellScreenH,
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

  return (
    <>
      <div
        className="crop-overlay absolute z-40 overflow-hidden"
        style={{
          left,
          top,
          width,
          height,
          borderRadius: 12 * zoom,
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="pointer-events-none absolute inset-0 bg-black/20" />
        {cells}
      </div>

      {dragging && (
        <div
          className="pointer-events-none fixed z-[9999] rounded-lg border-2 border-primary bg-primary/10 shadow-xl backdrop-blur-sm"
          style={{
            left: dragging.cx - cellScreenW / 2,
            top: dragging.cy - cellScreenH / 2,
            width: cellScreenW,
            height: cellScreenH,
          }}
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
  const viewport = useCanvasStore((s) => s.viewport);

  const targetCardId =
    editingCardId ??
    (selectedCardIds.size === 1
      ? Array.from(selectedCardIds)[0]
      : undefined);

  const card = useCardStore((s) =>
    targetCardId ? s.cards.get(targetCardId) : undefined,
  );

  const dragOffset = useCanvasStore((s) =>
    targetCardId ? s.dragOffsets.get(targetCardId) ?? null : null,
  );

  const [activeGrid, setActiveGrid] = useState<number | null>(null);
  const [cropping, setCropping] = useState(false);
  const gridCardId = useRef<string | null>(null);

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
        model: "SeedVR2-Upscaler",
        provider: "jijing",
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

    injectOnConnect(card.id, newCard.id);

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

  const zoom = viewport.zoom;
  const dragScreenDx = dragOffset ? dragOffset.dx * zoom : 0;
  const dragScreenDy = dragOffset ? dragOffset.dy * zoom : 0;
  const cardScreenLeft = card.x * zoom + viewport.x + dragScreenDx;
  const cardScreenTop = card.y * zoom + viewport.y + dragScreenDy;
  const cardScreenWidth = card.width * zoom;

  const activeLabel = GRID_OPTIONS.find((o) => o.size === activeGrid)?.label;

  return (
    <>
      <div
        className="absolute z-50"
        style={{
          left: cardScreenLeft + cardScreenWidth / 2,
          top: cardScreenTop - TOOLBAR_GAP,
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

        <div className="mx-0.5 h-4 w-px bg-border" />

        <button
          title="高清放大"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={handleUpscale}
        >
          <ZoomIn className="h-3.5 w-3.5" />
          <span>高清放大</span>
        </button>

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

      {activeGrid && (
        <GridOverlay
          card={card}
          gridSize={activeGrid}
          viewport={viewport}
          onCellDrop={handleCellDrop}
          disabled={cropping}
          dragOffset={dragOffset}
        />
      )}
    </>
  );
}
