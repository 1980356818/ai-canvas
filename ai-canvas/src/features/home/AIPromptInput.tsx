import { useState, useRef, useCallback, useEffect } from "react";
import { MessageSquare, ImageIcon, SendHorizonal, X, ImagePlus } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useProjectStore } from "@/stores/projectStore";
import { useChatStore } from "@/stores/chatStore";
import { createProject, hasApiKey, isTauri } from "@/lib/tauri";
import { persistImage, getDisplayUrl } from "@/lib/media";
import { ensureDisplayableImage } from "@/lib/heicConverter";
import { modelService } from "@/services/models";
import { cn } from "@/lib/utils";
import ModelSelector from "@/features/editor/ModelSelector";

type InputMode = "chat" | "image";

interface UploadedImage {
  url: string;
  displayUrl: string;
}

const IMAGE_LABELS = ["图一", "图二", "图三", "图四", "图五"];
const MAX_IMAGES = 5;
const ACCEPTED_MIME = [
  "image/png", "image/jpeg", "image/gif", "image/webp",
  "image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence",
];

const MODE_CONFIG: Record<
  InputMode,
  {
    label: string;
    icon: typeof MessageSquare;
    placeholder: string;
  }
> = {
  chat: {
    label: "文字",
    icon: MessageSquare,
    placeholder: "描述你的需求，AI 将为你解答...",
  },
  image: {
    label: "图片",
    icon: ImageIcon,
    placeholder:
      "描述你想生成的图片，例如「户外运动风格的模特穿搭图，蓝色系背景」...",
  },
};

export default function AIPromptInput() {
  const [mode, setMode] = useState<InputMode>("chat");
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [selectedModel, setSelectedModel] = useState("");
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);
  const config = MODE_CONFIG[mode];

  useEffect(() => {
    const loadDefault = mode === "chat"
      ? modelService.getDefaultChatModel()
      : modelService.getDefaultImageModel();
    loadDefault.then(setSelectedModel);
  }, [mode]);

  const addImages = useCallback(async (sources: string[]) => {
    const remaining = MAX_IMAGES - images.length;
    if (remaining <= 0) {
      useUIStore.getState().addToast({
        type: "warning",
        title: `最多上传 ${MAX_IMAGES} 张图片`,
        duration: 3000,
      });
      return;
    }
    const toAdd = sources.slice(0, remaining);
    const results = await Promise.all(
      toAdd.map(async (src) => {
        const { localPath } = await persistImage(src);
        return { url: localPath, displayUrl: getDisplayUrl(localPath) };
      }),
    );
    setImages((prev) => [...prev, ...results]);
  }, [images.length]);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
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

    const rawFiles = Array.from(e.dataTransfer.files).filter((f) =>
      ACCEPTED_MIME.includes(f.type),
    );
    if (rawFiles.length === 0) return;

    const converted = await Promise.all(rawFiles.map(ensureDisplayableImage));
    const dataUrls = await Promise.all(
      converted.map(
        (f) =>
          new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(f);
          }),
      ),
    );
    addImages(dataUrls);
  }, [addImages]);

  const handlePickFile = useCallback(async () => {
    if (isTauri) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: true,
          filters: [
            { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif"] },
          ],
        });
        if (!selected) return;
        const paths = Array.isArray(selected)
          ? selected.map((s) => (typeof s === "string" ? s : (s as { path: string }).path))
          : [typeof selected === "string" ? selected : (selected as { path: string }).path];
        addImages(paths);
      } catch (err) {
        console.error("Failed to pick file:", err);
      }
    } else {
      fileInputRef.current?.click();
    }
  }, [addImages]);

  const handleFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const rawFiles = Array.from(e.target.files ?? []);
      if (rawFiles.length === 0) return;
      const converted = await Promise.all(rawFiles.map(ensureDisplayableImage));
      const dataUrls = await Promise.all(
        converted.map(
          (f) =>
            new Promise<string>((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.readAsDataURL(f);
            }),
        ),
      );
      addImages(dataUrls);
      e.target.value = "";
    },
    [addImages],
  );

  const clearInput = useCallback(() => {
    setPrompt("");
    setImages([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, []);

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
      useUIStore.getState().setAppView("canvas");

      if (!useUIStore.getState().chatPanelVisible) {
        useUIStore.getState().toggleChatPanel();
      }

      const chatText = mode === "image" ? `/image ${trimmed}` : trimmed;
      const chatImages = images.map((img) => img.url);

      clearInput();

      await useChatStore.getState().createSession();
      await useChatStore.getState().sendMessage(chatText, chatImages.length > 0 ? chatImages : undefined);
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
  }, [prompt, sending, mode, images, clearInput]);

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
                松开鼠标，上传图片
              </p>
            </div>
          </div>
        )}

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

        {/* Image previews */}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pb-2">
            {images.map((img, i) => (
              <div key={i} className="group relative">
                <div className="relative overflow-hidden rounded-lg border border-border/60 bg-muted/30">
                  <img
                    src={img.displayUrl}
                    alt={IMAGE_LABELS[i] ?? `图${i + 1}`}
                    className="h-16 w-16 object-cover"
                  />
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-1 pb-0.5 pt-3">
                    <span className="text-[10px] font-medium leading-none text-white">
                      {IMAGE_LABELS[i] ?? `图${i + 1}`}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeImage(i)}
                  className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            ))}

            {images.length < MAX_IMAGES && (
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
          {(Object.keys(MODE_CONFIG) as InputMode[]).map((m) => {
            const { label, icon: Icon } = MODE_CONFIG[m];
            return (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-all duration-200",
                  mode === m
                    ? "bg-foreground/10 text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
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

          {(prompt.trim() || images.length > 0) && (
            <button
              type="button"
              onClick={clearInput}
              className="mr-1 flex h-8 items-center gap-1 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              title="清空内容"
            >
              <X className="h-3.5 w-3.5" />
              清空
            </button>
          )}

          {images.length === 0 && (
            <button
              type="button"
              onClick={handlePickFile}
              className="mr-1 flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              title="上传图片"
            >
              <ImagePlus className="h-4 w-4" />
            </button>
          )}

          {!isTauri && (
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/heic,image/heif,.heic,.heif"
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
