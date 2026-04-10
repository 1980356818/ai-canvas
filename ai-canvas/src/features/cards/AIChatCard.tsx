import { memo, useState, useCallback, useRef, useEffect } from "react";
import { MessageSquare, Loader2, Pencil } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { autoSave } from "@/lib/autoSave";
import MarkdownContent from "@/shared/MarkdownContent";

export default memo(function AIChatCard({ card }: { card: CanvasCard }) {
  const data = card.data as { content?: string; result?: string };
  const genProgress = useUIStore((s) => s.generatingCards.get(card.id));
  const streamContent = useUIStore((s) => s.streamingContents.get(card.id));
  const updateCard = useCardStore((s) => s.updateCard);

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const startEditing = useCallback(() => {
    setEditValue(data.result ?? "");
    setEditing(true);
  }, [data.result]);

  const finishEditing = useCallback(() => {
    setEditing(false);
    if (editValue !== data.result) {
      updateCard(card.id, { data: { ...data, result: editValue } });
      autoSave.markDirty(card.id);
    }
  }, [card.id, data, editValue, updateCard]);

  const onEditChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      setEditValue(val);
      updateCard(card.id, { data: { ...data, result: val } });
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => autoSave.markDirty(card.id), 400);
    },
    [card.id, data, updateCard],
  );

  if (streamContent) {
    return (
      <div className="relative h-full overflow-y-auto p-3">
        <div className="prose prose-sm dark:prose-invert text-xs leading-relaxed">
          <MarkdownContent content={streamContent} compact />
        </div>
        <div className="pointer-events-none sticky inset-x-0 bottom-0 flex items-center justify-center pb-2">
          <span className="flex items-center gap-1.5 rounded-full bg-primary/80 px-3 py-1 text-[10px] text-primary-foreground backdrop-blur-sm">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            生成中…
          </span>
        </div>
      </div>
    );
  }

  if (genProgress) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary/60" />
        <div className="w-full max-w-[80%] space-y-1.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            {genProgress.percent > 0 ? (
              <div
                className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                style={{ width: `${genProgress.percent}%` }}
              />
            ) : (
              <div className="h-full w-1/3 animate-[shimmer_1.5s_ease-in-out_infinite] rounded-full bg-primary/60" />
            )}
          </div>
          <p className="text-center text-[10px] text-muted-foreground">
            {genProgress.label}
          </p>
        </div>
      </div>
    );
  }

  if (data.result) {
    if (editing) {
      return (
        <div
          className="h-full overflow-hidden p-3"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <textarea
            ref={textareaRef}
            className="h-full w-full resize-none rounded-lg bg-muted/20 px-2.5 py-2 text-sm leading-relaxed text-card-foreground outline-none ring-1 ring-primary/40 focus:ring-primary/70"
            value={editValue}
            onChange={onEditChange}
            onBlur={finishEditing}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                finishEditing();
              }
            }}
          />
        </div>
      );
    }

    return (
      <div
        className="group/result relative h-full overflow-y-auto p-3"
        onDoubleClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          startEditing();
        }}
      >
        <div className="prose prose-sm dark:prose-invert text-xs leading-relaxed">
          <MarkdownContent content={data.result} compact />
        </div>
        <div className="pointer-events-none sticky inset-x-0 bottom-0 flex items-center justify-center pb-2 opacity-0 transition-opacity group-hover/result:opacity-100">
          <span className="flex items-center gap-1 rounded-full bg-black/50 px-2.5 py-1 text-[10px] text-white backdrop-blur-sm">
            <Pencil className="h-2.5 w-2.5" />
            双击编辑
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground/50">
      <MessageSquare className="h-8 w-8" />
      <span className="text-xs">
        {data.content ? "等待生成" : "生成文字"}
      </span>
    </div>
  );
});
