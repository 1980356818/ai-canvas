import { memo } from "react";
import type { CanvasCard } from "@/stores/cardStore";

export default memo(function StickyNoteCard({ card }: { card: CanvasCard }) {
  const data = card.data as { content?: string };
  const content = data.content ?? "";

  return (
    <div className="h-full w-full overflow-hidden bg-amber-50 p-3 dark:bg-amber-900/20">
      {content ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-card-foreground">
          {content}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground/50">双击编辑便签</p>
      )}
    </div>
  );
});
