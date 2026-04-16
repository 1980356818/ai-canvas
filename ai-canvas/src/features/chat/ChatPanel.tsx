import { useEffect, useCallback, useState } from "react";
import { MessageSquare, X, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import { useUIStore } from "@/stores/uiStore";
import { cn } from "@/lib/utils";
import ChatSessionList from "./ChatSessionList";
import ChatMessageList from "./ChatMessageList";
import ChatInput from "./ChatInput";

export default function ChatPanel() {
  const toggleChatPanel = useUIStore((s) => s.toggleChatPanel);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const sessions = useChatStore((s) => s.sessions);
  const currentTitle =
    sessions.find((s) => s.id === currentSessionId)?.title ?? "New Chat";

  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const handleNewChat = useCallback(async () => {
    await useChatStore.getState().createSession();
  }, []);

  return (
    <aside className="absolute right-3 top-3 bottom-3 z-30 flex w-[420px] flex-col overflow-hidden rounded-xl border border-border/60 bg-background/80 shadow-lg backdrop-blur-xl">
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
        <div className="flex flex-1 flex-col min-h-0">
          <ChatMessageList />
          <ChatInput />
        </div>
      </div>
    </aside>
  );
}
