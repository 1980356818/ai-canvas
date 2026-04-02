import { useState, useRef, useCallback } from "react";
import { MessageSquare, ImageIcon, SendHorizonal } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useProjectStore } from "@/stores/projectStore";
import { useCardStore } from "@/stores/cardStore";
import { createProject, hasApiKey } from "@/lib/tauri";
import { autoSave } from "@/lib/autoSave";
import { cn } from "@/lib/utils";
import { CARD_DEFAULTS } from "@/shared/constants";
import type { CardType } from "@/shared/types";

type InputMode = "chat" | "image";

const MODE_CONFIG: Record<
  InputMode,
  {
    label: string;
    icon: typeof MessageSquare;
    cardType: CardType;
    placeholder: string;
  }
> = {
  chat: {
    label: "文字",
    icon: MessageSquare,
    cardType: "ai_chat",
    placeholder: "描述你的需求，AI 将在画布上为你生成内容...",
  },
  image: {
    label: "图片",
    icon: ImageIcon,
    cardType: "ai_image",
    placeholder:
      "描述你想生成的图片，例如「户外运动风格的模特穿搭图，蓝色系背景」...",
  },
};

export default function AIPromptInput() {
  const [mode, setMode] = useState<InputMode>("chat");
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const config = MODE_CONFIG[mode];

  const handleSend = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || sending) return;

    setSending(true);
    try {
      if (!(await hasApiKey())) {
        useUIStore.getState().addToast({
          type: "warning",
          title: "请先配置 API Key",
          description: "前往设置页面配置你的 API Key 后再使用 AI 功能",
          action: {
            label: "打开设置",
            onClick: () => useUIStore.getState().toggleSettings(),
          },
          duration: 5000,
        });
        setSending(false);
        return;
      }

      const project = await createProject(trimmed.slice(0, 40));
      useProjectStore.getState().addProject(project);
      useProjectStore.getState().setCurrentProjectId(project.id);

      const now = new Date().toISOString();
      const cardType = config.cardType;
      const defaults = CARD_DEFAULTS[cardType];
      const cardData =
        cardType === "ai_chat"
          ? { messages: [{ role: "user", content: trimmed }] }
          : { content: trimmed };

      const card = {
        id: crypto.randomUUID(),
        projectId: project.id,
        type: cardType,
        x: 100,
        y: 100,
        width: defaults.width,
        height: defaults.height,
        zIndex: 1,
        locked: false,
        collapsed: false,
        data: cardData,
        createdAt: now,
        updatedAt: now,
      };

      useCardStore.getState().addCard(card);
      autoSave.markDirty(card.id);
      useUIStore.getState().setAppView("canvas");
      setPrompt("");
    } catch (err) {
      useUIStore.getState().addToast({
        type: "error",
        title: "创建项目失败",
        description: String(err),
        duration: 4000,
      });
    } finally {
      setSending(false);
    }
  }, [prompt, sending, config]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPrompt(e.target.value);
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="rounded-2xl border border-border bg-card shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-primary/20">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={handleTextareaInput}
          onKeyDown={handleKeyDown}
          placeholder={config.placeholder}
          rows={3}
          className="w-full resize-none rounded-t-2xl bg-transparent px-4 pb-2 pt-4 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          style={{ minHeight: "88px", maxHeight: "200px" }}
        />

        <div className="flex items-center gap-1 border-t border-border px-3 py-2">
          {(Object.keys(MODE_CONFIG) as InputMode[]).map((m) => {
            const { label, icon: Icon } = MODE_CONFIG[m];
            return (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                  mode === m
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            );
          })}

          <div className="flex-1" />

          <span className="mr-2 select-none text-xs text-muted-foreground">
            Ctrl+Enter 发送
          </span>

          <button
            onClick={handleSend}
            disabled={!prompt.trim() || sending}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
              prompt.trim() && !sending
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "cursor-not-allowed bg-muted text-muted-foreground",
            )}
            title="发送"
          >
            <SendHorizonal className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
