import { memo, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard } from "@/types";
import { autoSave } from "@/lib/autoSave";

export default memo(function StickyNoteCard({ card }: { card: CanvasCard }) {
  const data = card.data as { content?: string };
  const content = data.content ?? "";
  const isEditing = useCanvasStore((s) => s.editingCardId === card.id);
  const updateCard = useCardStore((s) => s.updateCard);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cursorRef = useRef<{ start: number; end: number } | null>(null);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      const ta = textareaRef.current;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
    }
  }, [isEditing]);

  useLayoutEffect(() => {
    const pos = cursorRef.current;
    if (pos && textareaRef.current) {
      textareaRef.current.selectionStart = pos.start;
      textareaRef.current.selectionEnd = pos.end;
      cursorRef.current = null;
    }
  });

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      cursorRef.current = { start: e.target.selectionStart, end: e.target.selectionEnd };
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

  return (
    <div className="flex h-full w-full flex-col bg-amber-50 p-3 dark:bg-amber-900/20">
      <textarea
        ref={textareaRef}
        className="min-h-0 flex-1 resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm leading-relaxed text-card-foreground outline-none ring-ring placeholder:text-muted-foreground/50 focus:ring-1"
        style={{ pointerEvents: isEditing ? "auto" : "none" }}
        value={content}
        readOnly={!isEditing}
        onChange={onChange}
        placeholder="点击编辑便签..."
        onPointerDown={stopDrag}
        onMouseDown={stopDrag}
      />
    </div>
  );
});
