import type { CanvasCard } from "@/stores/cardStore";
import TextEditor from "./TextEditor";
import ChatEditor from "./ChatEditor";
import MediaEditor from "./MediaEditor";

export default function EditorSwitch({ card }: { card: CanvasCard }) {
  switch (card.type) {
    case "text":
    case "sticky_note":
      return <TextEditor card={card} />;
    case "ai_chat":
      return <ChatEditor card={card} />;
    case "ai_image":
      return <MediaEditor card={card} />;
    default:
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          暂不支持编辑此类型
        </div>
      );
  }
}
