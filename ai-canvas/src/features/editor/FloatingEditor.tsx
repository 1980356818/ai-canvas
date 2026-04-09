import { useRef, useCallback, useEffect } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import EditorSwitch from "./EditorSwitch";

const GAP = 12;

const EDITOR_SIZES: Record<string, { height: number; minWidth: number }> = {
  ai_chat: { height: 320, minWidth: 560 },
  ai_image: { height: 320, minWidth: 560 },
  ai_tryon: { height: 300, minWidth: 560 },
};
const DEFAULT_SIZE = { height: 240, minWidth: 400 };

export default function FloatingEditor() {
  const editingCardId = useCanvasStore((s) => s.editingCardId);
  const viewport = useCanvasStore((s) => s.viewport);
  const card = useCardStore((s) =>
    editingCardId ? s.cards.get(editingCardId) : undefined,
  );
  const panelRef = useRef<HTMLDivElement>(null);

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

  if (!card) return null;

  const { height, minWidth } = EDITOR_SIZES[card.type] ?? DEFAULT_SIZE;
  const zoom = viewport.zoom;

  const baseWidth = Math.max(minWidth, card.width);
  const scaledWidth = baseWidth * zoom;

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
        width: baseWidth,
        height,
        transform: `scale(${zoom})`,
        transformOrigin: "top left",
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="h-full overflow-auto">
        <EditorSwitch card={card} />
      </div>
    </div>
  );
}
