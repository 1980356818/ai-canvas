import { useRef, useCallback, useEffect, useState } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { isEnhancerModel } from "@/config/model-ref-images";
import EditorSwitch from "./EditorSwitch";

const GAP = 12;
const MIN_EDITOR_WIDTH = 360;
const MIN_EDITOR_HEIGHT = 180;

const EDITOR_SIZES: Record<string, { height: number; minWidth: number }> = {
  ai_chat: { height: 280, minWidth: 560 },
  ai_image: { height: 320, minWidth: 560 },
  ai_video: { height: 300, minWidth: 560 },
  ai_tryon: { height: 300, minWidth: 560 },
  ai_multiangle: { height: 176, minWidth: 400 },
};
const DEFAULT_SIZE = { height: 240, minWidth: 400 };

const sizeMemory = new Map<string, { w: number; h: number }>();

export default function FloatingEditor() {
  const editingCardId = useCanvasStore((s) => s.editingCardId);
  const viewport = useCanvasStore((s) => s.viewport);
  const card = useCardStore((s) =>
    editingCardId ? s.cards.get(editingCardId) : undefined,
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const [userSize, setUserSize] = useState<{ w: number; h: number } | null>(null);
  const prevCardId = useRef<string | null>(null);

  if (editingCardId !== prevCardId.current) {
    prevCardId.current = editingCardId;
    setUserSize(editingCardId ? sizeMemory.get(editingCardId) ?? null : null);
  }

  const close = useCallback(() => {
    useCanvasStore.getState().setEditingCardId(null);
  }, []);

  useEffect(() => {
    if (!editingCardId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingCardId, close]);

  const startResize = useCallback(
    (e: React.PointerEvent, edge: "right" | "bottom" | "corner") => {
      e.preventDefault();
      e.stopPropagation();
      const el = panelRef.current;
      const handle = e.currentTarget as HTMLElement;
      if (!el) return;

      handle.setPointerCapture(e.pointerId);

      const zoom = useCanvasStore.getState().viewport.zoom;
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = el.offsetWidth;
      const startH = el.offsetHeight;

      const onMove = (ev: PointerEvent) => {
        ev.stopPropagation();
        const dx = (ev.clientX - startX) / zoom;
        const dy = (ev.clientY - startY) / zoom;
        const newW = edge === "bottom" ? startW : Math.max(MIN_EDITOR_WIDTH, startW + dx);
        const newH = edge === "right" ? startH : Math.max(MIN_EDITOR_HEIGHT, startH + dy);
        const size = { w: newW, h: newH };
        setUserSize(size);
        const cid = useCanvasStore.getState().editingCardId;
        if (cid) sizeMemory.set(cid, size);
      };

      const onUp = (ev: PointerEvent) => {
        ev.stopPropagation();
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
      };

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    },
    [],
  );

  const hasError = useUIStore((s) => editingCardId ? s.cardErrors.has(editingCardId) : false);

  if (!card) return null;
  if (card.type === "text" || card.type === "sticky_note") return null;

  const { height: baseHeight, minWidth } = EDITOR_SIZES[card.type] ?? DEFAULT_SIZE;
  const zoom = viewport.zoom;

  const data = card.data as Record<string, unknown> | undefined;
  const modelId = (data?.model as string) || "";
  const isEnhancer = isEnhancerModel(modelId);
  const refImages = data?.refImages as Record<string, unknown> | undefined;
  const hasRefImages = refImages && Object.keys(refImages).length > 0;
  const upstreamTexts = data?.upstreamTexts as Record<string, unknown> | undefined;
  const hasUpstream = upstreamTexts && Object.keys(upstreamTexts).length > 0;
  const refFrames = data?.refFrames as unknown[] | undefined;
  const hasRefFrames = refFrames && refFrames.length > 0;
  let autoHeight = isEnhancer ? 140 : baseHeight;
  if (card.type === "ai_multiangle") {
    if (hasError) autoHeight += 48;
  } else {
    if (hasRefImages) autoHeight += isEnhancer ? 80 : 112;
    else if (isEnhancer) autoHeight += 60;
    if (hasUpstream) autoHeight += 64;
    if (hasRefFrames) autoHeight += 90;
    if (hasError) autoHeight += 48;
  }

  const width = userSize ? userSize.w : Math.max(minWidth, card.width);
  const height = userSize ? userSize.h : autoHeight;

  const scaledWidth = width * zoom;
  const cardScreenLeft = card.x * zoom + viewport.x;
  const cardScreenCenterX = cardScreenLeft + card.width * zoom / 2;

  const screenLeft = cardScreenCenterX - scaledWidth / 2;
  const screenTop = (card.y + card.height) * zoom + viewport.y + GAP;

  return (
    <div
      ref={panelRef}
      className="absolute z-40 overflow-hidden rounded-xl border border-border bg-card shadow-xl"
      data-floating-editor
      data-editor-zoom={zoom}
      style={{
        left: screenLeft,
        top: screenTop,
        width,
        height,
        transform: `scale(${zoom})`,
        transformOrigin: "top left",
      }}
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="h-full overflow-auto">
        <EditorSwitch card={card} />
      </div>

      {/* Right edge resize handle */}
      <div
        className="absolute right-0 top-0 h-full w-1.5 cursor-e-resize opacity-0 transition-opacity hover:opacity-100 hover:bg-primary/20"
        onPointerDown={(e) => startResize(e, "right")}
      />
      {/* Bottom edge resize handle */}
      <div
        className="absolute bottom-0 left-0 h-1.5 w-full cursor-s-resize opacity-0 transition-opacity hover:opacity-100 hover:bg-primary/20"
        onPointerDown={(e) => startResize(e, "bottom")}
      />
      {/* Corner resize handle */}
      <div
        className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize"
        onPointerDown={(e) => startResize(e, "corner")}
      >
        <svg
          className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
          viewBox="0 0 10 10"
          fill="currentColor"
        >
          <circle cx="8" cy="8" r="1.2" />
          <circle cx="4" cy="8" r="1.2" />
          <circle cx="8" cy="4" r="1.2" />
        </svg>
      </div>
    </div>
  );
}
