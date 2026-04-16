import { useRef, useEffect } from "react";
import { MessageSquare, Loader2 } from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import ChatMessageBubble from "./ChatMessageBubble";

export default function ChatMessageList() {
  const messages = useChatStore((s) => s.messages);
  const generating = useChatStore((s) => s.generating);
  const generatingType = useChatStore((s) => s.generatingType);
  const streamingText = useChatStore((s) => s.streamingText);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages.length, streamingText]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3">
      {messages.length === 0 && !generating && (
        <div className="flex flex-col items-center justify-center gap-3 pt-20 text-muted-foreground/40">
          <MessageSquare className="h-10 w-10" />
          <p className="text-sm">开始一段对话</p>
          <div className="flex flex-col items-center gap-1 text-xs">
            <span>直接聊天，或使用指令</span>
            <div className="flex gap-2">
              <code className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                /image prompt
              </code>
              <code className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                /video prompt
              </code>
            </div>
          </div>
        </div>
      )}

      {messages.map((msg) => (
        <ChatMessageBubble key={msg.id} message={msg} />
      ))}

      {/* Streaming text preview */}
      {generating && streamingText && (
        <div className="mb-3 flex justify-start">
          <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-muted/60 px-3.5 py-2.5 text-sm">
            <p className="whitespace-pre-wrap">{streamingText}</p>
            <span className="inline-block h-4 w-1 animate-pulse bg-foreground/60" />
          </div>
        </div>
      )}

      {/* Loading indicator */}
      {generating && !streamingText && (
        <div className="mb-3 flex justify-start">
          <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm bg-muted/60 px-3.5 py-2.5 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {generatingType === "image"
              ? "正在生成图片..."
              : generatingType === "video"
                ? "正在生成视频..."
                : "正在思考..."}
          </div>
        </div>
      )}
    </div>
  );
}
