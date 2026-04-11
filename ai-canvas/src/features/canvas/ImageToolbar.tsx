import { useState, useEffect, useCallback, useRef, memo } from "react";
import { Scissors, X } from "lucide-react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { persistImage, getBase64ForApi } from "@/lib/media";
import { autoSave } from "@/lib/autoSave";
import { sizeFromRatio } from "@/shared/constants";
import { updateProjectMeta } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const GRID_OPTIONS = [
  { size: 2, label: "2×2" },
  { size: 3, label: "3×3" },
  { size: 4, label: "4×4" },
  { size: 5, label: "5×5" },
];

const TOOLBAR_GAP = 10;

function MiniGrid({ n, active }: { n: number; active: boolean }) {
  const cells = Array.from({ length: n * n });
  return (
    <div
      className="grid gap-px"
      style={{
        gridTemplateColumns: `repeat(${n}, 1fr)`,
        width: 14,
        height: 14,
      }}
    >
      {cells.map((_, i) => (
        <div
          key={i}
          className={cn(
            "rounded-[1px]",
            active ? "bg-primary-foreground" : "bg-current opacity-60",
          )}
        />
      ))}
    </div>
  );
}

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
        const cur = dragRef.current;
        if (cur) {
          onCellDrop({ row: cur.row, col: cur.col, clientX: ev.clientX, clientY: ev.clientY });
        }
        setDragging(null);
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
              : "cursor-grab active:cursor-grabbing",
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

  useEffect(() => {
    setActiveGrid(null);
  }, [targetCardId]);

  const handleCellDrop = useCallback(
    async (info: CellDragInfo) => {
      if (!card || !activeGrid || cropping) return;
      const data = card.data as { imageUrl?: string };
      if (!data.imageUrl) return;

      setCropping(true);
      try {
        const { dataUrl, cellW, cellH } = await cropImageCell(
          data.imageUrl,
          info.row,
          info.col,
          activeGrid,
        );
        const { localPath: relativePath } = await persistImage(dataUrl);

        const ratio = cellW / cellH;
        const { width: newW, height: newH } = sizeFromRatio(ratio);

        const { maxZIndex } = useCardStore.getState();
        const projectId = useProjectStore.getState().currentProjectId;
        if (!projectId) return;

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

  if (!card || card.type !== "ai_image") return null;
  const imgData = card.data as { imageUrl?: string };
  if (!imgData.imageUrl) return null;

  const zoom = viewport.zoom;
  const dragScreenDx = dragOffset ? dragOffset.dx * zoom : 0;
  const dragScreenDy = dragOffset ? dragOffset.dy * zoom : 0;
  const cardScreenLeft = card.x * zoom + viewport.x + dragScreenDx;
  const cardScreenTop = card.y * zoom + viewport.y + dragScreenDy;
  const cardScreenWidth = card.width * zoom;

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
        <Scissors className="mr-1 h-3.5 w-3.5 text-muted-foreground" />
        <span className="mr-1 text-xs text-muted-foreground">拆图</span>

        <div className="mx-1 h-4 w-px bg-border" />

        {GRID_OPTIONS.map(({ size, label }) => (
          <button
            key={size}
            title={`${label} 宫格拆分`}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
              activeGrid === size
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
            onClick={() => setActiveGrid(activeGrid === size ? null : size)}
          >
            <MiniGrid n={size} active={activeGrid === size} />
            {label}
          </button>
        ))}

        {activeGrid && (
          <>
            <div className="mx-1 h-4 w-px bg-border" />
            <button
              title="退出拆图模式"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setActiveGrid(null)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        )}
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
