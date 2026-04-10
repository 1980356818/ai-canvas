import { memo, useCallback, useRef } from "react";
import { MessageSquare, Loader2 } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { autoSave } from "@/lib/autoSave";

export default memo(function AIChatCard({ card }: { card: CanvasCard }) {
  const data = card.data as { content?: string; result?: string };
  const genProgress = useUIStore((s) => s.generatingCards.get(card.id));
  const updateCard = useCardStore((s) => s.updateCard);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const onResultChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const result = e.target.value;
      updateCard(card.id, { data: { ...data, result } });
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => autoSave.markDirty(card.id), 400);
    },
    [card.id, data, updateCard],
  );

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
    return (
      <div
        className="h-full p-4"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).tagName === "TEXTAREA") {
            e.stopPropagation();
          }
        }}
        onWheel={(e) => e.stopPropagation()}
      >
        <textarea
          data-card-result
          className="h-full w-full resize-none rounded-lg bg-transparent px-2 py-1.5 text-xs leading-relaxed text-card-foreground outline-none placeholder:text-muted-foreground focus:bg-muted/30 focus:ring-1 focus:ring-primary/30"
          value={data.result}
          onChange={onResultChange}
          placeholder="AI 生成的结果…"
        />
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
