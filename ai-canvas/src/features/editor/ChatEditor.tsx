import { useRef, useCallback, useState, useEffect } from "react";
import { Send, Loader2, Square } from "lucide-react";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { autoSave } from "@/lib/autoSave";
import { hasApiKey, aiProxyStream } from "@/lib/tauri";
import { modelService } from "@/services/models";
import { useUIStore } from "@/stores/uiStore";
import { cn } from "@/lib/utils";
import MarkdownContent from "@/shared/MarkdownContent";
import ModelSelector from "./ModelSelector";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatData {
  messages?: ChatMessage[];
  systemPrompt?: string;
  model?: string;
}

interface ChatEditorProps {
  card: CanvasCard;
}

function parseStreamChunk(raw: string): string {
  try {
    const json = JSON.parse(raw);
    return json?.choices?.[0]?.delta?.content ?? "";
  } catch {
    return "";
  }
}

function friendlyError(raw: string): string {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const msg = obj.message || obj.error?.message;
      if (msg) return msg;
    } catch { /* use raw */ }
  }
  return raw;
}

export default function ChatEditor({ card }: ChatEditorProps) {
  const updateCard = useCardStore((s) => s.updateCard);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState("");
  const [currentModel, setCurrentModel] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<(() => Promise<void>) | null>(null);
  const data = card.data as ChatData;
  const messages = data.messages ?? [];

  useEffect(() => {
    if (data.model) {
      setCurrentModel(data.model);
    } else {
      modelService.getDefaultChatModel().then(setCurrentModel);
    }
  }, [data.model]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, streamContent]);

  const handleModelChange = useCallback(
    (modelId: string) => {
      setCurrentModel(modelId);
      updateCard(card.id, { data: { ...data, model: modelId } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );

  const handleAbort = useCallback(async () => {
    if (abortRef.current) {
      await abortRef.current();
      abortRef.current = null;
    }
  }, []);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading || streaming) return;

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

    const userMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: text },
    ];
    updateCard(card.id, { data: { ...data, messages: userMessages } });
    autoSave.markDirty(card.id);
    setInput("");
    setLoading(true);
    setStreaming(false);
    setStreamContent("");

    const model = currentModel || "gpt-4o";
    const systemPrompt =
      data.systemPrompt ?? "你是一个有帮助的 AI 助手，请用中文回复。";

    const apiMessages = [
      { role: "system", content: systemPrompt },
      ...userMessages.map((m) => ({ role: m.role, content: m.content })),
    ];

    let accumulated = "";

    try {
      const { abort } = await aiProxyStream(
        "openai",
        "/v1/chat/completions",
        { model, messages: apiMessages },
        {
          onChunk(raw) {
            const token = parseStreamChunk(raw);
            if (token) {
              accumulated += token;
              setStreamContent(accumulated);
              if (!streaming) setStreaming(true);
            }
          },
          onDone() {
            const final_content = accumulated || "（无回复）";
            const assistantMessages: ChatMessage[] = [
              ...userMessages,
              { role: "assistant", content: final_content },
            ];
            useCardStore.getState().updateCard(card.id, {
              data: { ...data, messages: assistantMessages },
            });
            autoSave.markDirty(card.id);
            setLoading(false);
            setStreaming(false);
            setStreamContent("");
            abortRef.current = null;
          },
          onError(error) {
            if (accumulated) {
              const assistantMessages: ChatMessage[] = [
                ...userMessages,
                { role: "assistant", content: accumulated },
              ];
              useCardStore.getState().updateCard(card.id, {
                data: { ...data, messages: assistantMessages },
              });
            } else {
              const errorMessages: ChatMessage[] = [
                ...userMessages,
                { role: "assistant", content: `错误: ${friendlyError(error)}` },
              ];
              useCardStore.getState().updateCard(card.id, {
                data: { ...data, messages: errorMessages },
              });
            }
            autoSave.markDirty(card.id);
            setLoading(false);
            setStreaming(false);
            setStreamContent("");
            abortRef.current = null;
          },
        },
      );

      abortRef.current = abort;
      setStreaming(true);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errorMessages: ChatMessage[] = [
        ...userMessages,
        { role: "assistant", content: `错误: ${friendlyError(errMsg)}` },
      ];
      updateCard(card.id, { data: { ...data, messages: errorMessages } });
      autoSave.markDirty(card.id);
      setLoading(false);
      setStreaming(false);
    }
  }, [input, messages, card.id, data, updateCard, loading, streaming, currentModel]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage],
  );

  const isBusy = loading || streaming;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">模型</span>
        <ModelSelector
          capability="CHAT"
          value={currentModel}
          onChange={handleModelChange}
        />
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && !streaming && (
          <p className="pt-2 text-center text-sm text-muted-foreground">
            输入消息开始对话
          </p>
        )}
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
                "max-w-[80%] rounded-lg px-3 py-2 text-sm",
                msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-foreground",
              )}
            >
              <p className="mb-0.5 text-[10px] opacity-60">
                {msg.role === "user" ? "你" : "AI"}
              </p>
              {msg.role === "assistant" ? (
                <MarkdownContent content={msg.content} />
              ) : (
                <p className="whitespace-pre-wrap">{msg.content}</p>
              )}
            </div>
          </div>
        ))}

        {streaming && streamContent && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
              <p className="mb-0.5 text-[10px] opacity-60">AI</p>
              <MarkdownContent content={streamContent} />
            </div>
          </div>
        )}

        {loading && !streamContent && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在思考...
            </div>
          </div>
        )}
      </div>

      <div className="flex items-end gap-2 border-t border-border p-3">
        {streaming ? (
          <button
            onClick={handleAbort}
            className="flex h-9 flex-1 items-center justify-center gap-2 rounded-lg border border-border text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Square className="h-3 w-3" />
            停止生成
          </button>
        ) : (
          <>
            <textarea
              className="flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="输入消息... (Enter 发送)"
              disabled={isBusy}
              autoFocus
            />
            <button
              onClick={sendMessage}
              disabled={!input.trim() || isBusy}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors disabled:opacity-30"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
