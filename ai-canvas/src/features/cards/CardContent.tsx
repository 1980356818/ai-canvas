import { memo } from "react";
import { ImageIcon } from "lucide-react";
import type { CanvasCard } from "@/stores/cardStore";
import AIChatCard from "./AIChatCard";
import TextCard from "./TextCard";
import StickyNoteCard from "./StickyNoteCard";

function ImagePreview({ card }: { card: CanvasCard }) {
  const data = card.data as { content?: string; imageUrl?: string };
  if (data.imageUrl) {
    return (
      <div className="flex h-full w-full flex-col">
        <div className="min-h-0 flex-1">
          <img
            src={data.imageUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        </div>
        {data.content && (
          <div className="shrink-0 border-t border-border/40 bg-card/80 px-3 py-1.5">
            <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
              {data.content}
            </p>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground/50">
      <ImageIcon className="h-8 w-8" />
      <span className="text-xs">{data.content ? "等待生成" : "AI 图片"}</span>
      {data.content && (
        <p className="max-w-[80%] text-center text-[10px] leading-snug text-muted-foreground/40 line-clamp-2">
          {data.content}
        </p>
      )}
    </div>
  );
}

export default memo(function CardContent({ card }: { card: CanvasCard }) {
  switch (card.type) {
    case "ai_chat":
      return <AIChatCard card={card} />;
    case "text":
      return <TextCard card={card} />;
    case "sticky_note":
      return <StickyNoteCard card={card} />;
    case "ai_image":
      return <ImagePreview card={card} />;
    default:
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {card.type}
        </div>
      );
  }
});
