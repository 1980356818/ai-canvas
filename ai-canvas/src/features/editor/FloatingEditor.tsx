import { useRef, useState, useCallback, useEffect } from "react";
import { X } from "lucide-react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import EditorSwitch from "./EditorSwitch";

const EDITOR_HEIGHT = 220;
const GAP = 8;

export default function FloatingEditor() {
  const editingCardId = useCanvasStore((s) => s.editingCardId);
  const viewport = useCanvasStore((s) => s.viewport);
  const card = useCardStore((s) =>
    editingCardId ? s.cards.get(editingCardId) : undefined,
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const [height] = useState(EDITOR_HEIGHT);

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

  const cardScreenLeft = card.x * viewport.zoom + viewport.x;
  const cardScreenWidth = card.width * viewport.zoom;
  const cardScreenCenterX = cardScreenLeft + cardScreenWidth / 2;

  const editorWidth = Math.max(320, cardScreenWidth);
  const screenLeft = cardScreenCenterX - editorWidth / 2;
  const screenTop = (card.y + card.height) * viewport.zoom + viewport.y + GAP;
  const screenWidth = editorWidth;

  return (
    <div
      ref={panelRef}
      className="absolute z-40 overflow-hidden rounded-xl border border-border bg-card shadow-xl"
      style={{
        left: screenLeft,
        top: screenTop,
        width: screenWidth,
        height,
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex h-7 items-center justify-end border-b border-border px-2">
        <button
          onClick={close}
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="overflow-auto" style={{ height: height - 28 }}>
        <EditorSwitch card={card} />
      </div>
    </div>
  );
}
