import { memo } from "react";
import { cn } from "@/lib/utils";
import MarkdownContent from "@/shared/MarkdownContent";
import type { CanvasCard } from "@/stores/cardStore";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export default memo(function AIChatCard({ card }: { card: CanvasCard }) {
  const data = card.data as { messages?: ChatMessage[] };
  const messages = data.messages ?? [];

  return (
    <div className="flex h-full flex-col overflow-hidden p-3">
      {messages.length === 0 ? (
        <p className="pt-4 text-center text-sm text-muted-foreground/50">
          空对话
        </p>
      ) : (
        <div className="space-y-2 overflow-hidden">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={cn(
                "flex",
                msg.role === "user" ? "justify-end" : "justify-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs leading-relaxed",
                  msg.role === "user"
                    ? "bg-primary/10 text-foreground"
                    : "bg-muted text-foreground",
                )}
              >
                {msg.role === "assistant" ? (
                  <MarkdownContent content={msg.content} compact />
                ) : (
                  msg.content
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
