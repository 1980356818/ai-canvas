import { memo } from "react";
import { MessageSquare, Loader2 } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import MarkdownContent from "@/shared/MarkdownContent";
import type { CanvasCard } from "@/stores/cardStore";

export default memo(function AIChatCard({ card }: { card: CanvasCard }) {
  const data = card.data as { content?: string; result?: string };
  const genProgress = useUIStore((s) => s.generatingCards.get(card.id));

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
      <div className="h-full overflow-hidden p-3">
        <div className="prose prose-sm dark:prose-invert max-h-full overflow-hidden text-xs leading-relaxed">
          <MarkdownContent content={data.result} compact />
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
