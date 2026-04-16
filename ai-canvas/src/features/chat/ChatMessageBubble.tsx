import { memo, useState, useCallback } from "react";
import {
  Download,
  Maximize2,
  Copy,
  Play,
  Pause,
  X,
} from "lucide-react";
import type { ChatMessage } from "@/stores/chatStore";
import type { ChatContentPart } from "@/lib/chatService";
import { getDisplayUrl } from "@/lib/media";
import { cn } from "@/lib/utils";
import MarkdownContent from "@/shared/MarkdownContent";

interface Props {
  message: ChatMessage;
}

export default memo(function ChatMessageBubble({ message }: Props) {
  const isUser = message.role === "user";

  return (
    <div
      className={cn(
        "mb-3 flex",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3.5 py-2.5",
          isUser
            ? "rounded-tr-sm bg-primary text-primary-foreground"
            : "rounded-tl-sm bg-muted/60",
        )}
      >
        {message.content.map((part, idx) => (
          <ContentPartRenderer
            key={idx}
            part={part}
            isUser={isUser}
          />
        ))}
      </div>
    </div>
  );
});

function ContentPartRenderer({
  part,
  isUser,
}: {
  part: ChatContentPart;
  isUser: boolean;
}) {
  switch (part.type) {
    case "text":
      return isUser ? (
        <p className="text-sm whitespace-pre-wrap">{part.text}</p>
      ) : (
        <MarkdownContent content={part.text} compact />
      );
    case "image":
      return <ImageBlock url={part.url} prompt={part.prompt} />;
    case "video":
      return <VideoBlock url={part.url} prompt={part.prompt} />;
    case "loading":
      return (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
          {part.mediaType === "image"
            ? "正在生成图片..."
            : "正在生成视频..."}
        </div>
      );
    default:
      return null;
  }
}

// ── Image block ─────────────────────────────────────────────

function ImageBlock({
  url,
  prompt,
}: {
  url: string;
  prompt?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const displayUrl = getDisplayUrl(url);

  const handleCopyPrompt = useCallback(() => {
    if (prompt) navigator.clipboard.writeText(prompt);
  }, [prompt]);

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData(
        "application/x-chat-media",
        JSON.stringify({ type: "image", url, prompt }),
      );
      e.dataTransfer.effectAllowed = "copy";
    },
    [url, prompt],
  );

  return (
    <>
      <div className="group relative mt-1.5 mb-1 overflow-hidden rounded-lg">
        <img
          src={displayUrl}
          alt={prompt || "Generated image"}
          className="max-w-[320px] w-full rounded-lg object-cover cursor-grab active:cursor-grabbing"
          onClick={() => setExpanded(true)}
          draggable
          onDragStart={handleDragStart}
          loading="lazy"
        />
        <div className="absolute bottom-1.5 right-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={() => setExpanded(true)}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
            title="放大"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          {prompt && (
            <button
              onClick={handleCopyPrompt}
              className="flex h-7 w-7 items-center justify-center rounded-md bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
              title="复制 Prompt"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          )}
          <a
            href={displayUrl}
            download
            className="flex h-7 w-7 items-center justify-center rounded-md bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
            title="下载"
          >
            <Download className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>

      {/* Lightbox */}
      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setExpanded(false)}
        >
          <button
            onClick={() => setExpanded(false)}
            className="absolute top-4 right-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={displayUrl}
            alt={prompt || "Generated image"}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

// ── Video block ─────────────────────────────────────────────

function VideoBlock({
  url,
  prompt,
}: {
  url: string;
  prompt?: string;
}) {
  const [playing, setPlaying] = useState(false);
  const displayUrl = getDisplayUrl(url);

  const handleCopyPrompt = useCallback(() => {
    if (prompt) navigator.clipboard.writeText(prompt);
  }, [prompt]);

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData(
        "application/x-chat-media",
        JSON.stringify({ type: "video", url, prompt }),
      );
      e.dataTransfer.effectAllowed = "copy";
    },
    [url, prompt],
  );

  return (
    <div
      className="group relative mt-1.5 mb-1 overflow-hidden rounded-lg bg-black/5"
      draggable
      onDragStart={handleDragStart}
    >
      <video
        src={displayUrl}
        className="max-w-[320px] w-full rounded-lg"
        controls={playing}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onClick={(e) => {
          if (!playing) {
            (e.target as HTMLVideoElement).play();
          }
        }}
      />
      {!playing && (
        <div className="absolute inset-0 flex items-center justify-center">
          <button
            onClick={() => {
              const vid = document.querySelector(
                `video[src="${displayUrl}"]`,
              ) as HTMLVideoElement | null;
              vid?.play();
            }}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
          >
            <Play className="h-5 w-5 ml-0.5" />
          </button>
        </div>
      )}
      <div className="absolute bottom-1.5 right-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {playing && (
          <button
            onClick={() => {
              const vid = document.querySelector(
                `video[src="${displayUrl}"]`,
              ) as HTMLVideoElement | null;
              vid?.pause();
            }}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
            title="暂停"
          >
            <Pause className="h-3.5 w-3.5" />
          </button>
        )}
        {prompt && (
          <button
            onClick={handleCopyPrompt}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
            title="复制 Prompt"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        )}
        <a
          href={displayUrl}
          download
          className="flex h-7 w-7 items-center justify-center rounded-md bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
          title="下载"
        >
          <Download className="h-3.5 w-3.5" />
        </a>
      </div>
    </div>
  );
}
