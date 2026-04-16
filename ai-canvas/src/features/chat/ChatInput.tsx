import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from "react";
import {
  SendHorizonal,
  Loader2,
  Square,
  Image as ImageIcon,
  Video,
  Paperclip,
  X,
  ImagePlus,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import { useProjectStore } from "@/stores/projectStore";
import { persistImage, getDisplayUrl } from "@/lib/media";
import { CARD_REF_MIME, type CardRefPayload } from "@/config/model-ref-images";
import { cn } from "@/lib/utils";

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const isTauri =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

const SLASH_COMMANDS = [
  { command: "/image ", label: "生成图片", icon: ImageIcon, description: "输入 prompt 生成图片" },
  { command: "/video ", label: "生成视频", icon: Video, description: "输入 prompt 生成视频" },
];

interface ImageAttachment {
  url: string;
  displayUrl: string;
}

export interface ChatInputHandle {
  addImage: (src: string) => Promise<void>;
}

const ChatInput = forwardRef<ChatInputHandle>(function ChatInput(_props, ref) {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [selectedSlashIdx, setSelectedSlashIdx] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const dragCounterRef = useRef(0);
  const generating = useChatStore((s) => s.generating);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopGenerating = useChatStore((s) => s.stopGenerating);

  const filteredCommands = input.startsWith("/")
    ? SLASH_COMMANDS.filter((c) =>
        c.command.startsWith(input.split(" ")[0]!),
      )
    : SLASH_COMMANDS;

  useEffect(() => {
    if (input.startsWith("/") && !input.includes(" ")) {
      setShowSlashMenu(true);
      setSelectedSlashIdx(0);
    } else {
      setShowSlashMenu(false);
    }
  }, [input]);

  const handlePickImage = useCallback(async () => {
    if (isTauri) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: false,
          filters: [
            { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] },
          ],
        });
        if (!selected) return;
        const filePath =
          typeof selected === "string" ? selected : (selected as { path: string }).path;
        const pid = useProjectStore.getState().currentProjectId ?? undefined;
        const { localPath } = await persistImage(filePath, undefined, pid);
        setImages((prev) => [
          ...prev,
          { url: localPath, displayUrl: getDisplayUrl(localPath) },
        ]);
      } catch (err) {
        console.error("Failed to pick image:", err);
      }
    } else {
      fileInputRef.current?.click();
    }
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
      const pid = useProjectStore.getState().currentProjectId ?? undefined;
      const { localPath } = await persistImage(dataUrl, undefined, pid);
      setImages((prev) => [
        ...prev,
        { url: localPath, displayUrl: getDisplayUrl(localPath) },
      ]);
      e.target.value = "";
    },
    [],
  );

  const removeImage = useCallback((idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const isAlreadyPersisted = useCallback((src: string) => {
    return (
      !!src &&
      !src.startsWith("data:") &&
      !src.startsWith("http://") &&
      !src.startsWith("https://") &&
      !src.startsWith("blob:")
    );
  }, []);

  const addImageFromUrl = useCallback(async (src: string) => {
    if (generating) return;
    try {
      if (isAlreadyPersisted(src)) {
        setImages((prev) => [
          ...prev,
          { url: src, displayUrl: getDisplayUrl(src) },
        ]);
        return;
      }
      const pid = useProjectStore.getState().currentProjectId ?? undefined;
      const { localPath } = await persistImage(src, undefined, pid);
      setImages((prev) => [
        ...prev,
        { url: localPath, displayUrl: getDisplayUrl(localPath) },
      ]);
    } catch (err) {
      console.error("Failed to add image:", err);
    }
  }, [generating, isAlreadyPersisted]);

  useImperativeHandle(ref, () => ({ addImage: addImageFromUrl }), [addImageFromUrl]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (generating) return;
    dragCounterRef.current++;
    const types = Array.from(e.dataTransfer.types);
    if (types.includes("Files") || types.includes("application/x-chat-media") || types.includes(CARD_REF_MIME) || types.includes("text/uri-list")) {
      setDragOver(true);
    }
  }, [generating]);

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
    const types = Array.from(e.dataTransfer.types);
    e.dataTransfer.dropEffect = types.includes(CARD_REF_MIME) ? "link" : "copy";
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setDragOver(false);
    if (generating) return;

    const chatMediaRaw = e.dataTransfer.getData("application/x-chat-media");
    if (chatMediaRaw) {
      try {
        const media = JSON.parse(chatMediaRaw) as { type: string; url: string };
        if (media.type === "image" && media.url) {
          await addImageFromUrl(media.url);
        }
      } catch { /* ignore */ }
      return;
    }

    const cardRefRaw = e.dataTransfer.getData(CARD_REF_MIME);
    if (cardRefRaw) {
      try {
        const payload = JSON.parse(cardRefRaw) as CardRefPayload;
        if (payload.imageUrl) {
          await addImageFromUrl(payload.imageUrl);
        }
      } catch { /* ignore */ }
      return;
    }

    const htmlData = e.dataTransfer.getData("text/html");
    if (htmlData) {
      const match = htmlData.match(/<img[^>]+src="([^"]+)"/);
      if (match?.[1]) {
        await addImageFromUrl(match[1]);
        return;
      }
    }

    const files = Array.from(e.dataTransfer.files).filter((f) => IMAGE_MIME.has(f.type));
    if (files.length > 0) {
      const pid = useProjectStore.getState().currentProjectId ?? undefined;
      for (const file of files) {
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(file);
        });
        try {
          const { localPath } = await persistImage(dataUrl, undefined, pid);
          setImages((prev) => [
            ...prev,
            { url: localPath, displayUrl: getDisplayUrl(localPath) },
          ]);
        } catch { /* skip */ }
      }
    }
  }, [generating, addImageFromUrl]);

  const canSend = input.trim() || images.length > 0;

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if ((!text && images.length === 0) || generating) return;
    const attachedImages = [...images];
    setInput("");
    setImages([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    await sendMessage(text, attachedImages.map((img) => img.url));
  }, [input, images, generating, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (showSlashMenu) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedSlashIdx((i) => (i + 1) % filteredCommands.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedSlashIdx(
            (i) => (i - 1 + filteredCommands.length) % filteredCommands.length,
          );
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const cmd = filteredCommands[selectedSlashIdx];
          if (cmd) {
            setInput(cmd.command);
            setShowSlashMenu(false);
          }
          return;
        }
        if (e.key === "Escape") {
          setShowSlashMenu(false);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, showSlashMenu, filteredCommands, selectedSlashIdx],
  );

  const handleTextareaInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInput(e.target.value);
      const el = textareaRef.current;
      if (el) {
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
      }
    },
    [],
  );

  const intentHint = input.startsWith("/image ")
    ? "image"
    : input.startsWith("/video ")
      ? "video"
      : null;

  return (
    <div
      ref={dropZoneRef}
      className={cn(
        "relative border-t p-3 transition-colors",
        dragOver
          ? "border-primary/60 bg-primary/5"
          : "border-border",
      )}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-b-xl bg-primary/5 backdrop-blur-sm">
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-primary/40 px-4 py-2">
            <ImagePlus className="h-4 w-4 text-primary/60" />
            <span className="text-sm font-medium text-primary/80">松开添加图片</span>
          </div>
        </div>
      )}

      {/* Slash command menu */}
      {showSlashMenu && (
        <div className="mb-2 overflow-hidden rounded-lg border border-border bg-popover shadow-md">
          {filteredCommands.map((cmd, idx) => (
            <button
              key={cmd.command}
              className={cn(
                "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors",
                idx === selectedSlashIdx
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
              onClick={() => {
                setInput(cmd.command);
                setShowSlashMenu(false);
                textareaRef.current?.focus();
              }}
            >
              <cmd.icon className="h-4 w-4 shrink-0" />
              <span className="font-medium">{cmd.label}</span>
              <span className="text-xs text-muted-foreground/70">
                {cmd.description}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Image attachments preview */}
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {images.map((img, idx) => (
            <div key={idx} className="group relative">
              <img
                src={img.displayUrl}
                alt=""
                className="h-14 w-14 rounded-lg border border-border object-cover"
              />
              <button
                onClick={() => removeImage(idx)}
                className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground group-hover:flex"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Intent badge */}
      {intentHint && (
        <div className="mb-1.5 flex items-center gap-1.5">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
              intentHint === "image"
                ? "bg-blue-500/10 text-blue-500"
                : "bg-purple-500/10 text-purple-500",
            )}
          >
            {intentHint === "image" ? (
              <ImageIcon className="h-3 w-3" />
            ) : (
              <Video className="h-3 w-3" />
            )}
            {intentHint === "image" ? "图片生成模式" : "视频生成模式"}
          </span>
        </div>
      )}

      <div className="flex items-end gap-2">
        <button
          onClick={handlePickImage}
          disabled={generating}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          title="上传图片"
        >
          <Paperclip className="h-4 w-4" />
        </button>

        {!isTauri && (
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
          />
        )}

        <textarea
          ref={textareaRef}
          className="flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
          rows={1}
          value={input}
          onChange={handleTextareaInput}
          onKeyDown={handleKeyDown}
          placeholder="发送消息，输入 / 查看指令..."
          disabled={generating}
        />
        {generating ? (
          <button
            onClick={stopGenerating}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive text-destructive-foreground transition-colors hover:bg-destructive/90"
            title="停止生成"
          >
            <Square className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!canSend}
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors",
              canSend
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-muted text-muted-foreground cursor-not-allowed",
            )}
            title="发送"
          >
            <SendHorizonal className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
});

export default ChatInput;
