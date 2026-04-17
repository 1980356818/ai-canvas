import { memo, useRef, useCallback, useEffect } from "react";
import { Type } from "lucide-react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { autoSave } from "@/lib/autoSave";

export default memo(function TextCard({ card }: { card: CanvasCard }) {
  const data = card.data as { content?: string };
  const content = data.content ?? "";
  const isEditing = useCanvasStore((s) => s.editingCardId === card.id);
  const updateCard = useCardStore((s) => s.updateCard);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      const ta = textareaRef.current;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
    }
  }, [isEditing]);

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      updateCard(card.id, { data: { ...data, content: val } });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => autoSave.markDirty(card.id), 300);
    },
    [card.id, data, updateCard],
  );

  const stopDrag = useCallback((e: React.PointerEvent | React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  if (!content && !isEditing) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <Type className="h-12 w-12 opacity-40" />
        <span className="text-sm font-medium opacity-50">文本</span>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col p-4">
      {card.title && (
        <p className="mb-1.5 shrink-0 text-xs font-semibold text-muted-foreground">
          {card.title}
        </p>
      )}
      <textarea
        ref={textareaRef}
        className="min-h-0 flex-1 resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm leading-relaxed text-card-foreground outline-none ring-ring placeholder:text-muted-foreground/50 focus:ring-1"
        style={{ pointerEvents: isEditing ? "auto" : "none" }}
        value={content}
        readOnly={!isEditing}
        onChange={onChange}
        placeholder="点击编辑文本..."
        onPointerDown={stopDrag}
        onMouseDown={stopDrag}
      />
    </div>
  );
});
