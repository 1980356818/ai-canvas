import { useState, useRef, useCallback } from "react";
import { SendHorizonal, X, ImagePlus, Video, Lock } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useProjectStore } from "@/stores/projectStore";
import { useChatStore } from "@/stores/chatStore";
import { useProviderStore, parseModelRef } from "@/stores/providerStore";
import { createProject, hasApiKey, isTauri } from "@/platform";
import { persistImage, getDisplayUrl } from "@/lib/media";
import { ensureDisplayableImage } from "@/lib/heicConverter";
import { cn } from "@/lib/utils";
import ModelSelector from "@/features/editor/ModelSelector";
import { VIDEO_EXTENSIONS_REGEX, IMAGE_EXTENSIONS_REGEX } from "@/shared/mediaFormats";
import { useEntitlements } from "@/hooks/useEntitlements";
import { ensureProjectQuota } from "@/lib/projectQuota";

interface UploadedMedia {
  url: string;
  displayUrl: string;
  kind: "image" | "video";
}

const MEDIA_LABELS = ["附件一", "附件二", "附件三", "附件四", "附件五"];
const MAX_MEDIA = 5;

function isVideoFile(file: File): boolean {
  return file.type.startsWith("video/") || VIDEO_EXTENSIONS_REGEX.test(file.name);
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_EXTENSIONS_REGEX.test(file.name);
}

function isMediaFile(file: File): boolean {
  return isImageFile(file) || isVideoFile(file);
}

const UNIFIED_PLACEHOLDER = "描述你的需求，AI 将自动处理文字与图片...";

export default function AIPromptInput() {
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [media, setMedia] = useState<UploadedMedia[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  const activeChatRef = useProviderStore((s) => s.activeChatRef);
  const chatModelId = parseModelRef(activeChatRef).modelId;
  const chatProviderId = parseModelRef(activeChatRef).providerId;
  const ent = useEntitlements();

  const addMedia = useCallback(async (files: File[]) => {
    const remaining = MAX_MEDIA - media.length;
    if (remaining <= 0) {
      useUIStore.getState().addToast({
        type: "warning",
        title: `最多上传 ${MAX_MEDIA} 个附件`,
        duration: 3000,
      });
      return;
    }
    const toAdd = files.slice(0, remaining);
    const results: UploadedMedia[] = [];
    for (const raw of toAdd) {
      try {
        const video = isVideoFile(raw);
        const file = video ? raw : await ensureDisplayableImage(raw);
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(file);
        });
        const { localPath } = await persistImage(dataUrl);
        results.push({
          url: localPath,
          displayUrl: getDisplayUrl(localPath),
          kind: video ? "video" : "image",
        });
      } catch { /* skip */ }
    }
    if (results.length > 0) setMedia((prev) => [...prev, ...results]);
  }, [media.length]);

  const addMediaFromPaths = useCallback(async (paths: string[]) => {
    const remaining = MAX_MEDIA - media.length;
    if (remaining <= 0) {
      useUIStore.getState().addToast({
        type: "warning",
        title: `最多上传 ${MAX_MEDIA} 个附件`,
        duration: 3000,
      });
      return;
    }
    const toAdd = paths.slice(0, remaining);
    const results = await Promise.all(
      toAdd.map(async (src) => {
        const { localPath } = await persistImage(src);
        const video = VIDEO_EXTENSIONS_REGEX.test(src);
        return { url: localPath, displayUrl: getDisplayUrl(localPath), kind: (video ? "video" : "image") as "image" | "video" };
      }),
    );
    setMedia((prev) => [...prev, ...results]);
  }, [media.length]);

  const removeMedia = useCallback((index: number) => {
    setMedia((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setDragOver(false);

    const rawFiles = Array.from(e.dataTransfer.files).filter(isMediaFile);
    if (rawFiles.length === 0) return;

    await addMedia(rawFiles);
  }, [addMedia]);

  const handlePickFile = useCallback(async () => {
    if (isTauri) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: true,
          filters: [
            { name: "图片/视频", extensions: ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "mp4", "webm", "mov", "avi", "mkv"] },
          ],
        });
        if (!selected) return;
        const paths = Array.isArray(selected)
          ? selected.map((s) => (typeof s === "string" ? s : (s as { path: string }).path))
          : [typeof selected === "string" ? selected : (selected as { path: string }).path];
        await addMediaFromPaths(paths);
      } catch (err) {
        console.error("Failed to pick file:", err);
      }
    } else {
      fileInputRef.current?.click();
    }
  }, [addMediaFromPaths]);

  const handleFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const rawFiles = Array.from(e.target.files ?? []).filter(isMediaFile);
      if (rawFiles.length === 0) return;
      await addMedia(rawFiles);
      e.target.value = "";
    },
    [addMedia],
  );

  const clearInput = useCallback(() => {
    setPrompt("");
    setMedia([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, []);

  const handleSend = useCallback(async () => {
    if (sending) return;
    if (!ent.allowBlank) {
      useUIStore.getState().openUpgrade("AI 自由创作为正式版功能，升级会员后解锁");
      return;
    }
    if (!ensureProjectQuota()) return;
    const trimmed = prompt.trim();
    if (!trimmed) return;

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
      useUIStore.getState().setAppView("canvas");

      if (!useUIStore.getState().chatPanelVisible) {
        useUIStore.getState().toggleChatPanel();
      }

      await useChatStore.getState().openProjectChat(project.id);

      const chatText = trimmed;
      const chatImages = media.filter((m) => m.kind === "image").map((m) => m.url);
      const chatVideos = media.filter((m) => m.kind === "video").map((m) => m.url);

      clearInput();

      await useChatStore.getState().createSession();
      await useChatStore.getState().sendMessage(
        chatText,
        chatImages.length > 0 ? chatImages : undefined,
        chatVideos.length > 0 ? chatVideos : undefined,
      );
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
  }, [prompt, sending, media, clearInput, ent.allowBlank]);

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
    <div className="relative z-10 mx-auto w-full max-w-4xl">
      <div
        className={cn(
          "rounded-2xl border bg-card/60 shadow-lg shadow-black/5 backdrop-blur-xl transition-all focus-within:shadow-xl focus-within:shadow-primary/10",
          dragOver
            ? "border-primary/60 ring-2 ring-primary/20"
            : "border-border/50",
        )}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Drag overlay */}
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-primary/5 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-primary/40 px-8 py-6">
              <ImagePlus className="h-8 w-8 text-primary/60" />
              <p className="text-sm font-medium text-primary/80">
                松开鼠标，上传图片/视频
              </p>
            </div>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={handleTextareaInput}
          onKeyDown={handleKeyDown}
          placeholder={UNIFIED_PLACEHOLDER}
          rows={3}
          className="w-full resize-none rounded-t-2xl bg-transparent px-5 pb-2 pt-5 text-base text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
          style={{ minHeight: "180px", maxHeight: "320px" }}
        />

        {/* Media previews */}
        {media.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pb-2">
            {media.map((item, i) => (
              <div key={i} className="group relative">
                <div className="relative overflow-hidden rounded-lg border border-border/60 bg-muted/30">
                  {item.kind === "video" ? (
                    <div className="relative h-16 w-20">
                      <video
                        src={item.displayUrl}
                        className="h-full w-full object-cover"
                        preload="none"
                        muted
                      />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Video className="h-4 w-4 text-white drop-shadow-md" />
                      </div>
                    </div>
                  ) : (
                    <img
                      src={item.displayUrl}
                      alt={MEDIA_LABELS[i] ?? `附件${i + 1}`}
                      className="h-16 w-16 object-cover"
                      loading="lazy"
                      decoding="async"
                    />
                  )}
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-1 pb-0.5 pt-3">
                    <span className="text-[10px] font-medium leading-none text-white">
                      {MEDIA_LABELS[i] ?? `附件${i + 1}`}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeMedia(i)}
                  className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            ))}

            {media.length < MAX_MEDIA && (
              <button
                type="button"
                onClick={handlePickFile}
                className="flex h-16 w-16 flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-border/60 text-muted-foreground/60 transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary/60"
              >
                <ImagePlus className="h-4 w-4" />
                <span className="text-[9px]">添加</span>
              </button>
            )}
          </div>
        )}

        <div className="flex items-center gap-1 border-t border-border/40 px-4 py-2.5">
          <ModelSelector
            capability="CHAT"
            value={chatModelId}
            providerId={chatProviderId}
            onChange={(modelId, providerId) => {
              useProviderStore.getState().setActiveRef("chat", `${providerId}:${modelId}`);
            }}
          />

          <div className="flex-1" />

          {(prompt.trim() || media.length > 0) && (
            <button
              type="button"
              onClick={clearInput}
              className="mr-1 flex h-8 items-center gap-1 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="清空内容"
            >
              <X className="h-3.5 w-3.5" />
              清空
            </button>
          )}

          {media.length === 0 && (
            <button
              type="button"
              onClick={handlePickFile}
              className="mr-1 flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="上传图片/视频"
            >
              <ImagePlus className="h-4 w-4" />
            </button>
          )}

          {!isTauri && (
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*,.heic,.heif,.mp4,.webm,.mov,.avi,.mkv"
              multiple
              className="hidden"
              onChange={handleFileInputChange}
            />
          )}

          <span className="mr-2 hidden select-none text-xs text-muted-foreground/60 sm:inline">
            Ctrl+Enter
          </span>

          <button
            onClick={handleSend}
            disabled={sending || (ent.allowBlank && !prompt.trim())}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full transition-all duration-200",
              !ent.allowBlank
                ? "bg-foreground/80 text-background shadow-sm hover:opacity-80"
                : prompt.trim() && !sending
                  ? "bg-foreground text-background shadow-sm hover:opacity-80"
                  : "cursor-not-allowed bg-muted text-muted-foreground",
            )}
            title={!ent.allowBlank ? "升级解锁 AI 自由创作" : "发送"}
          >
            {!ent.allowBlank ? <Lock className="h-4 w-4" /> : <SendHorizonal className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
