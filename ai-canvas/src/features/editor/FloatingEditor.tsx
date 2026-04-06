import { useRef, useCallback, useEffect } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import EditorSwitch from "./EditorSwitch";

const GAP = 12;

const EDITOR_SIZES: Record<string, { height: number; minWidth: number }> = {
  ai_image: { height: 200, minWidth: 440 },
  ai_tryon: { height: 280, minWidth: 460 },
};
const DEFAULT_SIZE = { height: 220, minWidth: 320 };

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

  const cardScreenLeft = card.x * viewport.zoom + viewport.x;
  const cardScreenWidth = card.width * viewport.zoom;
  const cardScreenCenterX = cardScreenLeft + cardScreenWidth / 2;

  const editorWidth = Math.max(minWidth, cardScreenWidth);
  const screenLeft = cardScreenCenterX - editorWidth / 2;
  const screenTop = (card.y + card.height) * viewport.zoom + viewport.y + GAP;

  return (
    <div
      ref={panelRef}
      className="absolute z-40 overflow-hidden rounded-xl border border-border bg-card shadow-xl"
      data-floating-editor
      style={{
        left: screenLeft,
        top: screenTop,
        width: editorWidth,
        height,
        transform: "none",
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
