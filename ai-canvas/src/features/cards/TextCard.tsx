import { memo, useRef, useCallback, useEffect } from "react";
import { Type } from "lucide-react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard } from "@/types";
import { autoSave } from "@/lib/autoSave";

export default memo(function TextCard({ card }: { card: CanvasCard }) {
  const data = card.data as { content?: string };
  const content = data.content ?? "";
  const dataRef = useRef(data);
  dataRef.current = data;
  const isEditing = useCanvasStore((s) => s.editingCardId === card.id);
  const updateCard = useCardStore((s) => s.updateCard);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const focusedOnceRef = useRef(false);
  const isComposingRef = useRef(false);
  // 非受控：textarea 自己管 value，store 只在外部 content 真正变化时同步进来，
  // 避免每次按键都受控重渲染破坏光标 / IME 合成。
  const lastSyncedRef = useRef<string>(content);

  useEffect(() => {
    if (isEditing && textareaRef.current && !focusedOnceRef.current) {
      const ta = textareaRef.current;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
      focusedOnceRef.current = true;
    }
    if (!isEditing) focusedOnceRef.current = false;
  }, [isEditing]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (content === lastSyncedRef.current) return;
    if (isComposingRef.current) return;
    lastSyncedRef.current = content;
    if (ta.value !== content) ta.value = content;
  }, [content]);

  const commitChange = useCallback(
    (val: string) => {
      lastSyncedRef.current = val;
      updateCard(card.id, { data: { ...dataRef.current, content: val } });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => autoSave.markDirty(card.id), 300);
    },
    [card.id, updateCard],
  );

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      if ((e.nativeEvent as InputEvent).isComposing || isComposingRef.current) return;
      commitChange(e.target.value);
    },
    [commitChange],
  );

  const onCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const onCompositionEnd = useCallback(
    (e: React.CompositionEvent<HTMLTextAreaElement>) => {
      isComposingRef.current = false;
      commitChange((e.target as HTMLTextAreaElement).value);
    },
    [commitChange],
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
        defaultValue={content}
        readOnly={!isEditing}
        onChange={onChange}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        placeholder="点击编辑文本..."
        onPointerDown={stopDrag}
        onMouseDown={stopDrag}
        onWheel={(e) => e.stopPropagation()}
      />
    </div>
  );
});
