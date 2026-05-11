import { useState, useRef, useCallback, useEffect } from "react";
import { SendHorizonal, Bot, Loader2, X, Trash2, AlertCircle } from "lucide-react";
import { useAgentStore } from "@/stores/agentStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { hasApiKey } from "@/platform";
import { cn } from "@/lib/utils";
import type { ContentPart } from "@/agent/types";
import AgentMessage from "./AgentMessage";
import AttachmentPicker from "./AttachmentPicker";

export default function AgentPanel() {
  const messages = useAgentStore((s) => s.messages);
  const status = useAgentStore((s) => s.status);
  const error = useAgentStore((s) => s.error);
  const sendMessage = useAgentStore((s) => s.sendMessage);
  const clearSession = useAgentStore((s) => s.clearSession);
  const projectId = useProjectStore((s) => s.currentProjectId);
  const toggleAgentPanel = useUIStore((s) => s.toggleAgentPanel);

  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ContentPart[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isBusy = status === "thinking" || status === "calling_tool";

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || !projectId || isBusy) return;

    const content: ContentPart[] = [];
    if (text) content.push({ type: "text", text });
    content.push(...attachments);

    if (!(await hasApiKey())) {
      useUIStore.getState().addToast({
        type: "warning",
        title: "请先配置 API Key",
        description: "前往设置页面配置你的 API Key",
        action: {
          label: "打开设置",
          onClick: () => useUIStore.getState().toggleSettings(),
        },
        duration: 5000,
      });
      return;
    }

    setInput("");
    setAttachments([]);

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    await sendMessage(projectId, content);
  }, [input, attachments, projectId, isBusy, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleTextareaInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInput(e.target.value);
      const el = textareaRef.current;
      if (el) {
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
      }
    },
    [],
  );

  return (
    <aside className="absolute right-3 top-3 bottom-3 z-30 flex w-[360px] flex-col overflow-hidden rounded-xl border border-border/60 bg-background/80 shadow-lg backdrop-blur-xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">AI 助手</span>
          {isBusy && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={clearSession}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="清空对话"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={toggleAgentPanel}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="关闭"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-2">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 pt-20 text-muted-foreground/50">
            <Bot className="h-10 w-10" />
            <p className="text-sm">发送消息或图片开始对话</p>
            <p className="text-xs">支持上传图片进行分析和生成</p>
          </div>
        )}
        {messages.map((msg) => (
          <AgentMessage key={msg.id} message={msg} />
        ))}

        {isBusy && (
          <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {status === "thinking" ? "正在思考..." : "正在执行工具..."}
          </div>
        )}

        {error && (
          <div className="mx-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-border p-3">
        <AttachmentPicker
          attachments={attachments}
          onAdd={(a) => setAttachments((p) => [...p, a])}
          onRemove={(i) => setAttachments((p) => p.filter((_, idx) => idx !== i))}
          projectId={projectId ?? undefined}
        />
        <div className="mt-2 flex items-end gap-2">
          <textarea
            ref={textareaRef}
            className="flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
            rows={1}
            value={input}
            onChange={handleTextareaInput}
            onKeyDown={handleKeyDown}
            placeholder="描述需求或上传图片... (Enter 发送)"
            disabled={isBusy}
          />
          <button
            onClick={handleSend}
            disabled={isBusy || (!input.trim() && attachments.length === 0)}
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors",
              !isBusy && (input.trim() || attachments.length > 0)
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-muted text-muted-foreground cursor-not-allowed",
            )}
          >
            {isBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <SendHorizonal className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </aside>
  );
}
