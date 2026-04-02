import { memo } from "react";
import { Bot, User, Wrench, AlertCircle, CheckCircle2, ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import MarkdownContent from "@/shared/MarkdownContent";
import type { AgentMessage as AgentMessageType, ContentPart } from "@/agent/types";

function renderContent(parts: ContentPart[], isUser: boolean) {
  return parts.map((part, i) => {
    if (part.type === "text") {
      return isUser ? (
        <p key={i} className="whitespace-pre-wrap text-sm leading-relaxed">
          {part.text}
        </p>
      ) : (
        <MarkdownContent key={i} content={part.text} />
      );
    }
    if (part.type === "image") {
      return (
        <img
          key={i}
          src={part.url}
          alt=""
          className="mt-1 max-h-48 rounded-lg object-cover"
        />
      );
    }
    return (
      <span key={i} className="text-xs text-muted-foreground">
        [附件: {(part as ContentPart & { type: "file" }).name}]
      </span>
    );
  });
}

function ToolCallBadge({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
      <Wrench className="h-3 w-3" />
      {name}
    </span>
  );
}

export default memo(function AgentMessage({
  message,
}: {
  message: AgentMessageType;
}) {
  const isUser = message.role === "user";
  const isTool = message.role === "tool";

  if (isTool) {
    const success = message.toolResult?.success ?? false;
    return (
      <div className="flex items-start gap-2 px-4 py-1.5">
        <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
          {success ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          ) : (
            <AlertCircle className="h-4 w-4 text-destructive" />
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {success ? "工具执行完成" : "工具执行失败"}
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex gap-2.5 px-4 py-2.5",
        isUser ? "flex-row-reverse" : "flex-row",
      )}
    >
      <div
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
          isUser ? "bg-primary text-primary-foreground" : "bg-accent text-accent-foreground",
        )}
      >
        {isUser ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
      </div>

      <div
        className={cn(
          "max-w-[85%] space-y-1.5 rounded-xl px-3.5 py-2.5",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-card border border-border",
        )}
      >
        {message.toolCalls?.map((tc) => (
          <ToolCallBadge key={tc.id} name={tc.name} />
        ))}
        {renderContent(message.content, isUser)}
        {message.content.some((p) => p.type === "image") && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <ImageIcon className="h-3 w-3" />
            附带图片
          </div>
        )}
      </div>
    </div>
  );
});
