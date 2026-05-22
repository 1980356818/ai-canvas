import { useRef, useEffect, useState, useMemo } from "react";
import { MessageSquare, Loader2, ImageIcon, Video, ChevronUp } from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import { useElapsedTimer } from "@/hooks/useElapsedTimer";
import ChatMessageBubble from "./ChatMessageBubble";
import ReasoningBlock from "./ReasoningBlock";

const STATUS_LABELS: Record<string, string> = {
  submitting: "提交任务中",
  queued: "排队中",
  processing: "处理中",
  downloading: "下载资源中",
  running: "生成中",
  pending: "等待中",
  done: "完成",
};

/**
 * 一次只渲染最近 N 条消息。chatStore 单会话已经 cap 在 500 条，
 * 这里再做一层"按需展开"——绝大多数场景只看最近的 100 条，没必要把整段
 * markdown 一起塞进 DOM。用户点顶部按钮可向前再拉 INCREMENT 条。
 *
 * 不用 react-window 之类的虚拟化方案：markdown 渲染高度难以预估，
 * 列表抖动严重；分页按钮简单、可控、对聊天行为很自然。
 */
const INITIAL_VISIBLE_COUNT = 100;
const LOAD_MORE_INCREMENT = 100;

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
  const streamingReasoning = useChatStore((s) => s.streamingReasoning);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const currentSessionId = useChatStore((s) => s.currentSessionId);

  const hasAnyStream = !!streamingText || !!streamingReasoning;
  const isMediaGenerating = generating && !hasAnyStream && (generatingType === "image" || generatingType === "video");
  const hasLoadingPart = isMediaGenerating && messages.some((m) => m.content.some((p) => p.type === "loading"));
  const showMediaCard = isMediaGenerating && !hasLoadingPart;
  // 纯"正在思考..."占位：什么流都还没来
  const isThinking = generating && !hasAnyStream && !isMediaGenerating;

  // 当前展开渲染的消息数；会话切换时重置回初始窗口
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT);
  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_COUNT);
  }, [currentSessionId]);

  const visibleMessages = useMemo(() => {
    if (messages.length <= visibleCount) return messages;
    return messages.slice(messages.length - visibleCount);
  }, [messages, visibleCount]);
  const hiddenOlderCount = messages.length - visibleMessages.length;

  const showTimer = (isMediaGenerating || isThinking) && generatingStartedAt > 0;
  // v5：共享全局 tick（见 useElapsedTimer 文件头注释）；showTimer=false 时传 null 即停。
  const elapsed = useElapsedTimer(showTimer ? generatingStartedAt : null);

  // Scroll-to-bottom 节流：rAF 合并连续触发；流式期间用 `auto` 避免浏览器
  // 不停 cancel/restart smooth 动画（每个 token 都触发会让主线程被 scroll 占住）。
  useEffect(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTo({
        top: el.scrollHeight,
        behavior: generating ? "auto" : "smooth",
      });
    });
  }, [visibleMessages.length, streamingText, streamingReasoning, generatingProgress, generating]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, []);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3">
      {messages.length === 0 && !generating && (
        <div className="flex flex-col items-center justify-center gap-3 pt-20 text-muted-foreground/40">
          <MessageSquare className="h-10 w-10" />
          <p className="text-sm">开始一段对话</p>
          <p className="text-xs">直接聊天，支持图片和视频生成</p>
        </div>
      )}

      {hiddenOlderCount > 0 && (
        <div className="mb-3 flex justify-center">
          <button
            type="button"
            onClick={() =>
              setVisibleCount((n) =>
                Math.min(messages.length, n + LOAD_MORE_INCREMENT),
              )
            }
            className="flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-[11px] text-muted-foreground hover:bg-muted transition-colors"
          >
            <ChevronUp className="h-3 w-3" />
            查看更早的 {Math.min(hiddenOlderCount, LOAD_MORE_INCREMENT)} 条
          </button>
        </div>
      )}

      {visibleMessages.map((msg) => (
        <ChatMessageBubble key={msg.id} message={msg} />
      ))}

      {generating && (streamingText || streamingReasoning) && (
        <div className="mb-3 flex justify-start">
          <div className="min-w-0 max-w-[85%] overflow-hidden rounded-2xl rounded-tl-sm bg-muted/60 px-3.5 py-2.5 text-sm">
            {streamingReasoning && (
              <ReasoningBlock
                text={streamingReasoning}
                streaming
                defaultOpen={!streamingText}
              />
            )}
            {streamingText && (
              <>
                <p className="whitespace-pre-wrap">{streamingText}</p>
                <span className="inline-block h-4 w-1 animate-pulse bg-foreground/60" />
              </>
            )}
          </div>
        </div>
      )}

      {showMediaCard && (
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
