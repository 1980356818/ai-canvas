import { useState, useRef, useCallback, useEffect } from "react";
import { MessageSquare, ImageIcon, SendHorizonal } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useProjectStore } from "@/stores/projectStore";
import { useCardStore } from "@/stores/cardStore";
import { createProject, hasApiKey, updateProjectMeta } from "@/lib/tauri";
import { autoSave } from "@/lib/autoSave";
import { modelService } from "@/services/models";
import { cn } from "@/lib/utils";
import { CARD_DEFAULTS } from "@/shared/constants";
import ModelSelector from "@/features/editor/ModelSelector";
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
  const [selectedModel, setSelectedModel] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const config = MODE_CONFIG[mode];

  useEffect(() => {
    const loadDefault = mode === "chat"
      ? modelService.getDefaultChatModel()
      : modelService.getDefaultImageModel();
    loadDefault.then(setSelectedModel);
  }, [mode]);

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
      useProjectStore.getState().openProject(project.id);

      const now = new Date().toISOString();
      const cardType = config.cardType;
      const defaults = CARD_DEFAULTS[cardType];
      const cardData =
        cardType === "ai_chat"
          ? { messages: [{ role: "user", content: trimmed }], model: selectedModel || undefined }
          : { content: trimmed, model: selectedModel || undefined };

      const card = {
        id: crypto.randomUUID(),
        projectId: project.id,
        type: cardType,
        x: 320,
        y: 80,
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
      await autoSave.forceSave();
      const meta = { nodeCount: 1 };
      useProjectStore.getState().updateProject(project.id, meta);
      await updateProjectMeta(project.id, meta);
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
    <div className="relative z-10 mx-auto w-full max-w-2xl">
      <div className="rounded-2xl border border-border/50 bg-card/60 shadow-lg shadow-black/5 backdrop-blur-xl transition-shadow focus-within:shadow-xl focus-within:shadow-primary/10">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={handleTextareaInput}
          onKeyDown={handleKeyDown}
          placeholder={config.placeholder}
          rows={3}
          className="w-full resize-none rounded-t-2xl bg-transparent px-5 pb-2 pt-5 text-base text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
          style={{ minHeight: "100px", maxHeight: "200px" }}
        />

        <div className="flex items-center gap-1 border-t border-border/40 px-4 py-2.5">
          {(Object.keys(MODE_CONFIG) as InputMode[]).map((m) => {
            const { label, icon: Icon } = MODE_CONFIG[m];
            return (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  "flex items-center gap-3 rounded-full px-8 py-4 text-base font-medium transition-all duration-200",
                  mode === m
                    ? "bg-foreground/10 text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <Icon className="h-5 w-5" />
                {label}
              </button>
            );
          })}

          <div className="mx-1.5 h-4 w-px bg-border/40" />

          <ModelSelector
            capability={mode === "chat" ? "CHAT" : "IMAGE"}
            value={selectedModel}
            onChange={setSelectedModel}
          />

          <div className="flex-1" />

          <span className="mr-2 hidden select-none text-xs text-muted-foreground/60 sm:inline">
            Ctrl+Enter
          </span>

          <button
            onClick={handleSend}
            disabled={!prompt.trim() || sending}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full transition-all duration-200",
              prompt.trim() && !sending
                ? "bg-foreground text-background shadow-sm hover:opacity-80"
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
