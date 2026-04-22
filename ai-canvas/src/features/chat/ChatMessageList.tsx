import { useRef, useEffect, useState } from "react";
import { MessageSquare, Loader2, ImageIcon, Video } from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import ChatMessageBubble from "./ChatMessageBubble";

const STATUS_LABELS: Record<string, string> = {
  submitting: "提交任务中",
  queued: "排队中",
  processing: "处理中",
  downloading: "下载资源中",
  running: "生成中",
  pending: "等待中",
  done: "完成",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status.toLowerCase()] ?? status;
}

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

export default function ChatMessageList() {
  const messages = useChatStore((s) => s.messages);
  const generating = useChatStore((s) => s.generating);
  const generatingType = useChatStore((s) => s.generatingType);
  const generatingProgress = useChatStore((s) => s.generatingProgress);
  const generatingStatus = useChatStore((s) => s.generatingStatus);
  const generatingStartedAt = useChatStore((s) => s.generatingStartedAt);
  const streamingText = useChatStore((s) => s.streamingText);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isMediaGenerating = generating && !streamingText && (generatingType === "image" || generatingType === "video");
  const isThinking = generating && !streamingText && !isMediaGenerating;

  const [elapsed, setElapsed] = useState(0);

  const showTimer = (isMediaGenerating || isThinking) && generatingStartedAt > 0;

  useEffect(() => {
    if (!showTimer) {
      setElapsed(0);
      return;
    }
    setElapsed(Date.now() - generatingStartedAt);
    const timer = setInterval(() => {
      setElapsed(Date.now() - generatingStartedAt);
    }, 1000);
    return () => clearInterval(timer);
  }, [showTimer, generatingStartedAt]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages.length, streamingText, generatingProgress]);

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

      {generating && streamingText && (
        <div className="mb-3 flex justify-start">
          <div className="min-w-0 max-w-[85%] overflow-hidden rounded-2xl rounded-tl-sm bg-muted/60 px-3.5 py-2.5 text-sm">
            <p className="whitespace-pre-wrap">{streamingText}</p>
            <span className="inline-block h-4 w-1 animate-pulse bg-foreground/60" />
          </div>
        </div>
      )}

      {isMediaGenerating && (
        <div className="mb-3 flex justify-start">
          <div className="w-[260px] rounded-2xl rounded-tl-sm bg-muted/60 px-4 py-3">
            <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
              {generatingType === "image"
                ? <ImageIcon className="h-4 w-4 text-primary" />
                : <Video className="h-4 w-4 text-primary" />}
              <span className="font-medium">
                {generatingType === "image" ? "生成图片" : "生成视频"}
              </span>
            </div>

            <div className="mb-1.5 h-1.5 w-full overflow-hidden rounded-full bg-border/60">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                style={{ width: `${Math.max(generatingProgress, 2)}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-[11px] text-muted-foreground/70">
              <span className="flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                {generatingStatus ? statusLabel(generatingStatus) : "准备中"}
              </span>
              <span className="flex items-center gap-2 tabular-nums">
                {elapsed > 0 && <span>已耗时 {formatElapsed(elapsed)}</span>}
                <span>{Math.round(generatingProgress)}%</span>
              </span>
            </div>
          </div>
        </div>
      )}

      {isThinking && (
        <div className="mb-3 flex justify-start">
          <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm bg-muted/60 px-3.5 py-2.5 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>正在思考...</span>
            {elapsed >= 2000 && (
              <span className="text-[11px] tabular-nums text-muted-foreground/50">
                {formatElapsed(elapsed)}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
