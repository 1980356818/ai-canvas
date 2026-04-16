import { useEffect, useCallback, useState, useRef } from "react";
import { MessageSquare, X, PanelLeftClose, PanelLeftOpen, ImagePlus } from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import { useUIStore } from "@/stores/uiStore";
import { CARD_REF_MIME, type CardRefPayload } from "@/config/model-ref-images";
import { cn } from "@/lib/utils";
import ChatSessionList from "./ChatSessionList";
import ChatMessageList from "./ChatMessageList";
import ChatInput from "./ChatInput";
import type { ChatInputHandle } from "./ChatInput";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
const isImageFile = (f: File) => f.type.startsWith("image/") || IMAGE_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(`.${ext}`));

export default function ChatPanel() {
  const toggleChatPanel = useUIStore((s) => s.toggleChatPanel);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const sessions = useChatStore((s) => s.sessions);
  const currentTitle =
    sessions.find((s) => s.id === currentSessionId)?.title ?? "新对话";

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [panelDragOver, setPanelDragOver] = useState(false);
  const chatInputRef = useRef<ChatInputHandle>(null);
  const panelDragCounter = useRef(0);

  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;

    const onCardHover = (e: Event) => {
      const active = (e as CustomEvent).detail?.active;
      setPanelDragOver(active);
    };
    const onCardDrop = (e: Event) => {
      const { imageUrl } = (e as CustomEvent).detail ?? {};
      if (imageUrl) {
        chatInputRef.current?.addImage(imageUrl);
      }
      setPanelDragOver(false);
    };

    el.addEventListener("canvas-card-hover", onCardHover);
    el.addEventListener("canvas-card-drop", onCardDrop);
    return () => {
      el.removeEventListener("canvas-card-hover", onCardHover);
      el.removeEventListener("canvas-card-drop", onCardDrop);
    };
  }, []);

  const hasDragImage = useCallback((e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types);
    return types.includes("Files") || types.includes("application/x-chat-media") || types.includes(CARD_REF_MIME) || types.includes("text/uri-list");
  }, []);

  const handlePanelDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    panelDragCounter.current++;
    if (hasDragImage(e)) setPanelDragOver(true);
  }, [hasDragImage]);

  const handlePanelDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    panelDragCounter.current--;
    if (panelDragCounter.current <= 0) {
      panelDragCounter.current = 0;
      setPanelDragOver(false);
    }
  }, []);

  const handlePanelDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const types = Array.from(e.dataTransfer.types);
    e.dataTransfer.dropEffect = types.includes(CARD_REF_MIME) ? "link" : "copy";
  }, []);

  const handlePanelDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    panelDragCounter.current = 0;
    setPanelDragOver(false);

    const chatMediaRaw = e.dataTransfer.getData("application/x-chat-media");
    if (chatMediaRaw) {
      try {
        const media = JSON.parse(chatMediaRaw) as { type: string; url: string };
        if (media.type === "image" && media.url) {
          await chatInputRef.current?.addImage(media.url);
        }
      } catch { /* ignore */ }
      return;
    }

    const cardRefRaw = e.dataTransfer.getData(CARD_REF_MIME);
    if (cardRefRaw) {
      try {
        const payload = JSON.parse(cardRefRaw) as CardRefPayload;
        if (payload.imageUrl) {
          await chatInputRef.current?.addImage(payload.imageUrl);
        }
      } catch { /* ignore */ }
      return;
    }

    const htmlData = e.dataTransfer.getData("text/html");
    if (htmlData) {
      const match = htmlData.match(/<img[^>]+src="([^"]+)"/);
      if (match?.[1]) {
        await chatInputRef.current?.addImage(match[1]);
        return;
      }
    }

    const files = Array.from(e.dataTransfer.files).filter(isImageFile);
    for (const file of files) {
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
      await chatInputRef.current?.addImage(dataUrl);
    }
  }, []);

  const handleNewChat = useCallback(async () => {
    await useChatStore.getState().createSession();
  }, []);

  return (
    <aside
      ref={panelRef}
      data-ref-slot
      className={cn(
        "absolute right-3 top-3 bottom-3 z-30 flex w-[420px] flex-col overflow-hidden rounded-xl border bg-background/80 shadow-lg backdrop-blur-xl transition-colors",
        panelDragOver ? "border-primary/60 ring-2 ring-primary/20" : "border-border/60",
      )}
      onDragEnter={handlePanelDragEnter}
      onDragLeave={handlePanelDragLeave}
      onDragOver={handlePanelDragOver}
      onDrop={handlePanelDrop}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={sidebarOpen ? "关闭会话列表" : "打开会话列表"}
          >
            {sidebarOpen ? (
              <PanelLeftClose className="h-4 w-4" />
            ) : (
              <PanelLeftOpen className="h-4 w-4" />
            )}
          </button>
          <MessageSquare className="h-4 w-4 shrink-0 text-primary" />
          <span className="truncate text-sm font-semibold">{currentTitle}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleNewChat}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="新建对话"
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            onClick={toggleChatPanel}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="relative flex flex-1 min-h-0">
        {/* Session sidebar */}
        <div
          className={cn(
            "absolute inset-y-0 left-0 z-10 w-[200px] border-r border-border bg-background/95 backdrop-blur-sm transition-transform duration-200",
            sidebarOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <ChatSessionList onClose={() => setSidebarOpen(false)} />
        </div>

        {/* Messages area */}
        <div className="flex flex-1 flex-col min-h-0 relative">
          {panelDragOver && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-primary/5 backdrop-blur-[2px]">
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-primary/40 bg-background/80 px-5 py-3 shadow-sm">
                <ImagePlus className="h-5 w-5 text-primary/60" />
                <span className="text-sm font-medium text-primary/80">松开以添加参考图</span>
              </div>
            </div>
          )}
          <ChatMessageList />
          <ChatInput ref={chatInputRef} />
        </div>
      </div>
    </aside>
  );
}
