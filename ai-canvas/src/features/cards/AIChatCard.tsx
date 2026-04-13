import { memo, useCallback, useRef, useEffect } from "react";
import { Loader2, AlertTriangle } from "lucide-react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useUIStore } from "@/stores/uiStore";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { autoSave } from "@/lib/autoSave";

export default memo(function AIChatCard({ card }: { card: CanvasCard }) {
  const data = card.data as { content?: string; result?: string; _resultStale?: boolean };
  const genProgress = useUIStore((s) => s.generatingCards.get(card.id));
  const isEditing = useCanvasStore((s) => s.editingCardId === card.id);
  const updateCard = useCardStore((s) => s.updateCard);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditing && !genProgress && promptRef.current) {
      const ta = promptRef.current;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
    }
  }, [isEditing, genProgress]);

  const onResultChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const result = e.target.value;
      updateCard(card.id, { data: { ...data, result } });
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => autoSave.markDirty(card.id), 400);
    },
    [card.id, data, updateCard],
  );

  const stopDrag = useCallback((e: React.PointerEvent | React.MouseEvent) => {
    e.stopPropagation();
  }, []);

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

  return (
    <div className="flex h-full w-full flex-col p-4">
      {data._resultStale && data.result && (
        <div className="mb-1.5 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>最近一次生成失败，以下为上次成功的结果</span>
        </div>
      )}
      <textarea
        ref={promptRef}
        data-card-result
        className="min-h-0 flex-1 resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm leading-relaxed text-card-foreground outline-none ring-ring placeholder:text-muted-foreground/50 focus:ring-1"
        style={{ pointerEvents: isEditing ? "auto" : "none" }}
        value={data.result ?? ""}
        readOnly={!isEditing}
        onChange={onResultChange}
        placeholder="点击输入文本..."
        onPointerDown={stopDrag}
        onMouseDown={stopDrag}
      />
    </div>
  );
});
