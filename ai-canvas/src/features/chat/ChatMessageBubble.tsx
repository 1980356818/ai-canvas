import { memo, useState, useCallback } from "react";
import {
  Download,
  Copy,
  Play,
  Pause,
} from "lucide-react";
import type { ChatMessage } from "@/stores/chatStore";
import type { ChatContentPart } from "@/lib/chatService";
import { getDisplayUrl } from "@/lib/media";
import MarkdownContent from "@/shared/MarkdownContent";

const isTauri =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

interface Props {
  message: ChatMessage;
}

export default memo(function ChatMessageBubble({ message }: Props) {
  const isUser = message.role === "user";

  if (isUser) {
    const imageParts = message.content.filter((p) => p.type === "image");
    const otherParts = message.content.filter((p) => p.type !== "image");

    return (
      <div className="mb-3 flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-3.5 py-2.5">
          {imageParts.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {imageParts.map((part, idx) => (
                <UserImageThumb key={idx} url={(part as { url: string }).url} />
              ))}
            </div>
          )}
          {otherParts.map((part, idx) => (
            <ContentPartRenderer key={idx} part={part} isUser />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-3 flex justify-start">
      <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-muted/60 px-3.5 py-2.5">
        {message.content.map((part, idx) => (
          <ContentPartRenderer key={idx} part={part} isUser={false} />
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

// ── User image thumbnail ────────────────────────────────────

function UserImageThumb({ url }: { url: string }) {
  const displayUrl = getDisplayUrl(url);
  return (
    <img
      src={displayUrl}
      alt=""
      className="h-16 w-16 rounded-md border border-white/20 object-cover"
      loading="lazy"
    />
  );
}

// ── Image block ─────────────────────────────────────────────

function ImageBlock({
  url,
  prompt,
}: {
  url: string;
  prompt?: string;
}) {
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

  const handleRevealFile = useCallback(async () => {
    if (!isTauri) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_in_explorer", { path: url, projectId: null });
    } catch (err) {
      console.error("Reveal file failed:", err);
    }
  }, [url]);

  return (
    <div className="group relative mt-1.5 mb-1 overflow-hidden rounded-lg">
      <img
        src={displayUrl}
        alt={prompt || "生成的图片"}
        className="max-w-[320px] w-full rounded-lg object-cover cursor-grab active:cursor-grabbing"
        draggable
        onDragStart={handleDragStart}
        loading="lazy"
      />
      <div className="absolute bottom-1.5 right-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {prompt && (
          <button
            onClick={handleCopyPrompt}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
            title="复制 Prompt"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={handleRevealFile}
          className="flex h-7 w-7 items-center justify-center rounded-md bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
          title="在文件管理器中显示"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
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
        <button
          onClick={async () => {
            if (!isTauri) return;
            try {
              const { invoke } = await import("@tauri-apps/api/core");
              await invoke("open_in_explorer", { path: url, projectId: null });
            } catch (err) {
              console.error("Reveal file failed:", err);
            }
          }}
          className="flex h-7 w-7 items-center justify-center rounded-md bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
          title="在文件管理器中显示"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
