import { useCallback } from "react";
import { Trash2, MessageSquare } from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import { cn } from "@/lib/utils";

interface Props {
  onClose: () => void;
}

export default function ChatSessionList({ onClose }: Props) {
  const sessions = useChatStore((s) => s.sessions);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const switchSession = useChatStore((s) => s.switchSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const createSession = useChatStore((s) => s.createSession);

  const handleSwitch = useCallback(
    (id: string) => {
      switchSession(id);
      onClose();
    },
    [switchSession, onClose],
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      deleteSession(id);
    },
    [deleteSession],
  );

  const handleNew = useCallback(async () => {
    await createSession();
    onClose();
  }, [createSession, onClose]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2">
        <button
          onClick={handleNew}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <svg
            className="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          新建对话
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {sessions.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground/50">
            暂无对话
          </p>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => handleSwitch(s.id)}
            className={cn(
              "group flex cursor-pointer items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent",
              s.id === currentSessionId && "bg-accent",
            )}
          >
            <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate">{s.title}</span>
            <button
              onClick={(e) => handleDelete(e, s.id)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
              title="删除"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
