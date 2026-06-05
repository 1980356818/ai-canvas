import { memo, useState, useCallback, useEffect } from "react";
import { useElapsedTimer } from "@/hooks/useElapsedTimer";
import {
  Download,
  Copy,
  Play,
  Pause,
  Sparkles,
  Pencil,
  ImageIcon,
  Video,
  Loader2,
} from "lucide-react";
import type { ChatMessage } from "@/stores/chatStore";
import { useChatStore } from "@/stores/chatStore";
import type { ChatContentPart } from "@/types/chat";
import { getDisplayUrl } from "@/lib/media";
import { useProviderStore, parseModelRef } from "@/stores/providerStore";
import { modelService } from "@/services/models";
import { IMAGE_SIZE_OPTIONS, getAllowedSizesForModel, coerceToAllowedSize } from "@/shared/constants";
import type { ModelOption } from "@/providers/types";
import MarkdownContent from "@/shared/MarkdownContent";
import ReasoningBlock from "./ReasoningBlock";
import { cn } from "@/lib/utils";

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
        <div className="min-w-0 max-w-[85%] overflow-hidden rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-3.5 py-2.5">
          {imageParts.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {imageParts.map((part, idx) => (
                <UserImageThumb key={idx} url={(part as { url: string }).url} />
              ))}
            </div>
          )}
          {otherParts.map((part, idx) => (
            <ContentPartRenderer key={idx} part={part} isUser messageId={message.id} partIndex={idx} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-3 flex justify-start">
      <div className="min-w-0 max-w-[85%] overflow-hidden rounded-2xl rounded-tl-sm bg-muted/60 px-3.5 py-2.5">
        {message.content.map((part, idx) => (
          <ContentPartRenderer key={idx} part={part} isUser={false} messageId={message.id} partIndex={idx} />
        ))}
      </div>
    </div>
  );
});

function ContentPartRenderer({
  part,
  isUser,
  messageId,
  partIndex,
}: {
  part: ChatContentPart;
  isUser: boolean;
  messageId?: string;
  partIndex?: number;
}) {
  switch (part.type) {
    case "text":
      return isUser ? (
        <p className="text-sm whitespace-pre-wrap break-words">{part.text}</p>
      ) : (
        <MarkdownContent content={part.text} compact />
      );
    case "reasoning":
      // 用户消息里不应出现 reasoning，但保险起见兜底返回 null
      return isUser ? null : <ReasoningBlock text={part.text} />;
    case "image":
      return <ImageBlock url={part.url} prompt={part.prompt} />;
    case "video":
      return <VideoBlock url={part.url} prompt={part.prompt} />;
    case "loading":
      return <MediaLoadingCard mediaType={part.mediaType} />;
    case "image_pending":
      return (
        <PendingImageGenCard
          prompt={part.prompt}
          suggestedSize={part.suggestedSize}
          messageId={messageId ?? ""}
          partIndex={partIndex ?? 0}
        />
      );
    case "video_pending":
      return (
        <PendingVideoGenCard
          prompt={part.prompt}
          messageId={messageId ?? ""}
          partIndex={partIndex ?? 0}
        />
      );
    default:
      return null;
  }
}

// ── Media loading card (in-message progress) ────────────────

const STATUS_MAP: Record<string, string> = {
  submitting: "提交任务中",
  queued: "排队中",
  processing: "处理中",
  downloading: "下载资源中",
  running: "生成中",
  pending: "等待中",
  done: "完成",
};

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

function MediaLoadingCard({ mediaType }: { mediaType: "image" | "video" }) {
  const progress = useChatStore((s) => s.generatingProgress);
  const status = useChatStore((s) => s.generatingStatus);
  const startedAt = useChatStore((s) => s.generatingStartedAt);
  // v5：共享全局 tick，不再每个气泡起一个 setInterval（见 useElapsedTimer 文件头注释）
  const elapsed = useElapsedTimer(startedAt);

  const isImage = mediaType === "image";
  const label = status ? (STATUS_MAP[status.toLowerCase()] ?? status) : "准备中";

  return (
    <div className="mt-1.5 mb-1 w-full">
      <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
        {isImage
          ? <ImageIcon className="h-4 w-4 text-primary" />
          : <Video className="h-4 w-4 text-primary" />}
        <span className="font-medium">
          {isImage ? "生成图片" : "生成视频"}
        </span>
      </div>
      <div className="mb-1.5 h-1.5 w-full overflow-hidden rounded-full bg-border/60">
        <div
          className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
          style={{ width: `${Math.max(progress, 2)}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground/70">
        <span className="flex items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          {label}
        </span>
        <span className="flex items-center gap-2 tabular-nums">
          {elapsed > 0 && <span>已耗时 {formatElapsed(elapsed)}</span>}
          <span>{Math.round(progress)}%</span>
        </span>
      </div>
    </div>
  );
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
      decoding="async"
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
        className="max-w-full w-full rounded-lg object-cover cursor-grab active:cursor-grabbing"
        draggable
        onDragStart={handleDragStart}
        loading="lazy"
        decoding="async"
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
        className="max-w-full w-full rounded-lg"
        controls={playing}
        preload="none"
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

// ── Pending image generation card ────────────────────────────

const ALL_SIZE_OPTIONS = IMAGE_SIZE_OPTIONS.map((o) => ({ value: o.value, label: o.label }));

function PendingImageGenCard({
  prompt: initialPrompt,
  suggestedSize,
  messageId,
  partIndex,
}: {
  prompt: string;
  suggestedSize?: string;
  messageId: string;
  partIndex: number;
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModelRef, setSelectedModelRef] = useState("");
  const [size, setSize] = useState(suggestedSize || "1:1");
  const generating = useChatStore((s) => s.generating);
  const confirmImageGeneration = useChatStore((s) => s.confirmImageGeneration);
  const updatePendingPrompt = useChatStore((s) => s.updatePendingPrompt);

  const commitPromptEdit = useCallback(() => {
    setEditingPrompt(false);
    if (prompt !== initialPrompt) {
      updatePendingPrompt(messageId, partIndex, prompt);
    }
  }, [prompt, initialPrompt, messageId, partIndex, updatePendingPrompt]);

  const selectedModelId = parseModelRef(selectedModelRef).modelId;
  const allowedSizes = getAllowedSizesForModel(selectedModelId);
  const sizeOptions = allowedSizes
    ? ALL_SIZE_OPTIONS.filter((o) => allowedSizes.includes(o.value))
    : ALL_SIZE_OPTIONS;

  useEffect(() => {
    modelService.getByCapability("IMAGE").then((list) => {
      setModels(list);
      const activeRef = useProviderStore.getState().activeImageRef;
      const { providerId, modelId } = parseModelRef(activeRef);
      const match = list.find((m) => m.id === modelId && m.providerId === providerId);
      if (match) {
        setSelectedModelRef(`${match.providerId}:${match.id}`);
      } else if (list.length > 0) {
        setSelectedModelRef(`${list[0]!.providerId}:${list[0]!.id}`);
      }
    });
  }, []);

  useEffect(() => {
    if (!selectedModelId) return;
    const constrained = getAllowedSizesForModel(selectedModelId);
    setSize((prev) => coerceToAllowedSize(prev, constrained));
  }, [selectedModelId]);

  const handleGenerate = useCallback(() => {
    if (!prompt.trim() || !selectedModelRef || generating) return;
    useProviderStore.getState().setActiveRef("image", selectedModelRef);
    confirmImageGeneration(messageId, partIndex, prompt.trim(), selectedModelRef, size);
  }, [prompt, selectedModelRef, size, generating, messageId, partIndex, confirmImageGeneration]);

  const providerCount = new Set(models.map((m) => m.providerId)).size;

  return (
    <div className="mt-1.5 mb-1 rounded-lg border border-border bg-background p-3 space-y-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
        <Sparkles className="h-3.5 w-3.5" />
        图片生成
      </div>

      {/* Prompt */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">Prompt</span>
          <button
            type="button"
            onClick={editingPrompt ? commitPromptEdit : () => setEditingPrompt(true)}
            className="flex items-center gap-0.5 text-[10px] text-primary hover:underline"
          >
            <Pencil className="h-2.5 w-2.5" />
            {editingPrompt ? "完成" : "编辑"}
          </button>
        </div>
        {editingPrompt ? (
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={commitPromptEdit}
            className="w-full resize-none rounded border border-input bg-background px-2 py-1.5 text-xs outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
            rows={3}
            autoFocus
          />
        ) : (
          <p className="rounded bg-muted/50 px-2 py-1.5 text-xs text-foreground leading-relaxed">
            {prompt}
          </p>
        )}
      </div>

      {/* Model + Size selectors */}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <span className="mb-0.5 block text-[10px] text-muted-foreground">模型</span>
          <select
            value={selectedModelRef}
            onChange={(e) => setSelectedModelRef(e.target.value)}
            className="h-7 w-full appearance-none rounded border border-input bg-background px-2 text-[11px] outline-none ring-ring focus:ring-1"
          >
            {models.map((m) => {
              const key = `${m.providerId}:${m.id}`;
              const label = providerCount > 1
                ? `[${m.providerName}] ${m.display_name || m.id}`
                : (m.display_name || m.id);
              return (
                <option key={key} value={key}>{label}</option>
              );
            })}
          </select>
        </div>
        <div className="w-20 flex-shrink-0">
          <span className="mb-0.5 block text-[10px] text-muted-foreground">比例</span>
          <select
            value={size}
            onChange={(e) => setSize(e.target.value)}
            className="h-7 w-full appearance-none rounded border border-input bg-background px-2 text-[11px] outline-none ring-ring focus:ring-1"
          >
            {sizeOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Generate button */}
      <button
        type="button"
        onClick={handleGenerate}
        disabled={!prompt.trim() || !selectedModelRef || generating}
        className={cn(
          "flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium transition-colors",
          !prompt.trim() || !selectedModelRef || generating
            ? "bg-muted text-muted-foreground cursor-not-allowed"
            : "bg-primary text-primary-foreground hover:bg-primary/90",
        )}
      >
        <Sparkles className="h-3.5 w-3.5" />
        {generating ? "生成中..." : "生成图片"}
      </button>
    </div>
  );
}

// ── Pending video generation card ────────────────────────────

function PendingVideoGenCard({
  prompt: initialPrompt,
  messageId,
  partIndex,
}: {
  prompt: string;
  messageId: string;
  partIndex: number;
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModelRef, setSelectedModelRef] = useState("");
  const generating = useChatStore((s) => s.generating);
  const confirmVideoGeneration = useChatStore((s) => s.confirmVideoGeneration);
  const updatePendingPrompt = useChatStore((s) => s.updatePendingPrompt);

  const commitPromptEdit = useCallback(() => {
    setEditingPrompt(false);
    if (prompt !== initialPrompt) {
      updatePendingPrompt(messageId, partIndex, prompt);
    }
  }, [prompt, initialPrompt, messageId, partIndex, updatePendingPrompt]);

  useEffect(() => {
    modelService.getByCapability("VIDEO").then((list) => {
      setModels(list);
      const activeRef = useProviderStore.getState().activeVideoRef;
      const { providerId, modelId } = parseModelRef(activeRef);
      const match = list.find((m) => m.id === modelId && m.providerId === providerId);
      if (match) {
        setSelectedModelRef(`${match.providerId}:${match.id}`);
      } else if (list.length > 0) {
        setSelectedModelRef(`${list[0]!.providerId}:${list[0]!.id}`);
      }
    });
  }, []);

  const handleGenerate = useCallback(() => {
    if (!prompt.trim() || !selectedModelRef || generating) return;
    useProviderStore.getState().setActiveRef("video", selectedModelRef);
    confirmVideoGeneration(messageId, partIndex, prompt.trim(), selectedModelRef);
  }, [prompt, selectedModelRef, generating, messageId, partIndex, confirmVideoGeneration]);

  const providerCount = new Set(models.map((m) => m.providerId)).size;

  return (
    <div className="mt-1.5 mb-1 rounded-lg border border-border bg-background p-3 space-y-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
        <Video className="h-3.5 w-3.5" />
        视频生成
      </div>

      {/* Prompt */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">Prompt</span>
          <button
            type="button"
            onClick={editingPrompt ? commitPromptEdit : () => setEditingPrompt(true)}
            className="flex items-center gap-0.5 text-[10px] text-primary hover:underline"
          >
            <Pencil className="h-2.5 w-2.5" />
            {editingPrompt ? "完成" : "编辑"}
          </button>
        </div>
        {editingPrompt ? (
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={commitPromptEdit}
            className="w-full resize-none rounded border border-input bg-background px-2 py-1.5 text-xs outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
            rows={3}
            autoFocus
          />
        ) : (
          <p className="rounded bg-muted/50 px-2 py-1.5 text-xs text-foreground leading-relaxed">
            {prompt}
          </p>
        )}
      </div>

      {/* Model selector */}
      <div>
        <span className="mb-0.5 block text-[10px] text-muted-foreground">模型</span>
        <select
          value={selectedModelRef}
          onChange={(e) => setSelectedModelRef(e.target.value)}
          className="h-7 w-full appearance-none rounded border border-input bg-background px-2 text-[11px] outline-none ring-ring focus:ring-1"
        >
          {models.map((m) => {
            const key = `${m.providerId}:${m.id}`;
            const label = providerCount > 1
              ? `[${m.providerName}] ${m.display_name || m.id}`
              : (m.display_name || m.id);
            return (
              <option key={key} value={key}>{label}</option>
            );
          })}
        </select>
      </div>

      {/* Generate button */}
      <button
        type="button"
        onClick={handleGenerate}
        disabled={!prompt.trim() || !selectedModelRef || generating}
        className={cn(
          "flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium transition-colors",
          !prompt.trim() || !selectedModelRef || generating
            ? "bg-muted text-muted-foreground cursor-not-allowed"
            : "bg-primary text-primary-foreground hover:bg-primary/90",
        )}
      >
        <Video className="h-3.5 w-3.5" />
        {generating ? "生成中..." : "生成视频"}
      </button>
    </div>
  );
}
