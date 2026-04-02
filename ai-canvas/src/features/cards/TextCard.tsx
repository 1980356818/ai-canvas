import { memo } from "react";
import type { CanvasCard } from "@/stores/cardStore";

export default memo(function TextCard({ card }: { card: CanvasCard }) {
  const data = card.data as { content?: string };
  const content = data.content ?? "";

  return (
    <div className="h-full w-full overflow-hidden p-4">
      {card.title && (
        <p className="mb-1.5 text-xs font-semibold text-muted-foreground">
          {card.title}
        </p>
      )}
      {content ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-card-foreground">
          {content}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground/50">双击编辑文本</p>
      )}
    </div>
  );
});
