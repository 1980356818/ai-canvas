import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { Sparkles, RefreshCw, Loader2, Lock, X, AlertCircle, Paperclip, Video } from "lucide-react";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard, Connection } from "@/types";
import { useUIStore } from "@/stores/uiStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProjectStore } from "@/stores/projectStore";
import { autoSave } from "@/lib/autoSave";
import { hasApiKey } from "@/platform";
import type { UnifiedMessage, UnifiedContentPart } from "@/providers/types";
import "@/providers";
import { persistImage, getDisplayUrl, getBase64ForApi } from "@/lib/media";
import { ensureDisplayableImage } from "@/lib/heicConverter";
import { modelService } from "@/services/models";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import {
  getRefSlotsForChatModel,
  modelSupportsVision,
  compactRefImages,
  buildCompactKeyMap,
  type RefImageEntry,
} from "@/config/model-ref-images";
import { useImageRefSources } from "@/hooks/useImageRefSources";
import {
  type InlineImageRef,
  serializeForApi,
  getInlineRefUrls,
  toDisplayText,
  remapInlineRefs,
  reorderInlineRefs,
} from "@/lib/promptSerializer";
import ModelSelector from "./ModelSelector";
import RefImageSlot from "./RefImageSlot";
import PromptTextarea, { type PromptTextareaHandle } from "./PromptTextarea";

const isTauri =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "avi", "mkv", "mpeg"]);

interface MediaAttachment {
  url: string;
  displayUrl: string;
  kind: "image" | "video";
}

interface ChatData {
  content?: string;
  result?: string;
  model?: string;
  provider?: string;
  refImages?: Record<string, RefImageEntry>;
  inlineRefs?: InlineImageRef[];
  directMedia?: MediaAttachment[];
  _locked?: boolean;
  _systemPrompt?: string;
  _label?: string;
  _description?: string;
  _resultStale?: boolean;
}

export default function ChatEditor({ card }: { card: CanvasCard }) {
  const updateCard = useCardStore((s) => s.updateCard);
  const setCardProgress = useUIStore((s) => s.setCardProgress);
  const generating = useUIStore((s) => s.generatingCards.has(card.id));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const promptRef = useRef<PromptTextareaHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [currentModel, setCurrentModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const data = card.data as ChatData;
  const directMedia = data.directMedia ?? [];

  useEffect(() => {
    if (data.model && data.provider) {
      setCurrentModel(data.model);
    } else if (data.model) {
      setCurrentModel(data.model);
      const p = modelService.tryResolveProvider(data.model);
      if (p) updateCard(card.id, { data: { ...data, provider: p.descriptor.id } });
    } else {
      modelService.getDefaultChatModel().then(({ modelId, providerId }) => {
        setCurrentModel(modelId);
        updateCard(card.id, { data: { ...data, model: modelId, provider: providerId } });
      });
    }
  }, [data.model]);

  const refSlots = useMemo(() => {
    const slots = getRefSlotsForChatModel(currentModel);
    if (data._locked && slots.length === 0) {
      return getRefSlotsForChatModel("");
    }
    return slots;
  }, [currentModel, data._locked]);

  const [hoveredRefId, setHoveredRefId] = useState<string | null>(null);

  const imageOptions = useImageRefSources(card.id, refSlots, data.refImages);

  const handleModelChange = useCallback(
    (modelId: string, providerId: string) => {
      setCurrentModel(modelId);
      updateCard(card.id, { data: { ...data, model: modelId, provider: providerId } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );

  const addDirectMedia = useCallback(
    async (src: string, kind: "image" | "video") => {
      if (generating) return;
      const pid = useProjectStore.getState().currentProjectId ?? undefined;
      try {
        const isLocal = !!src && !src.startsWith("data:") && !src.startsWith("http") && !src.startsWith("blob:");
        let url: string;
        if (isLocal) {
          url = src;
        } else {
          const { localPath } = await persistImage(src, undefined, pid);
          url = localPath;
        }
        const newMedia = [...directMedia, { url, displayUrl: getDisplayUrl(url), kind }];
        updateCard(card.id, { data: { ...data, directMedia: newMedia } });
        autoSave.markDirty(card.id);
      } catch (err) {
        console.error(`Failed to add ${kind}:`, err);
      }
    },
    [card.id, data, directMedia, generating, updateCard],
  );

  const addFilesAsMedia = useCallback(
    async (files: File[]) => {
      if (generating) return;
      const pid = useProjectStore.getState().currentProjectId ?? undefined;
      const newMedia = [...directMedia];
      for (const raw of files) {
        try {
          const isVideo = raw.type.startsWith("video/");
          const file = isVideo ? raw : await ensureDisplayableImage(raw);
          const dataUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(file);
          });
          const { localPath } = await persistImage(dataUrl, undefined, pid);
          newMedia.push({ url: localPath, displayUrl: getDisplayUrl(localPath), kind: isVideo ? "video" : "image" });
        } catch { /* skip */ }
      }
      if (newMedia.length > directMedia.length) {
        updateCard(card.id, { data: { ...data, directMedia: newMedia } });
        autoSave.markDirty(card.id);
      }
    },
    [card.id, data, directMedia, generating, updateCard],
  );

  const removeDirectMedia = useCallback(
    (idx: number) => {
      const newMedia = directMedia.filter((_, i) => i !== idx);
      updateCard(card.id, { data: { ...data, directMedia: newMedia } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, directMedia, updateCard],
  );

  const handlePickMedia = useCallback(async () => {
    if (generating) return;
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
        const paths = Array.isArray(selected) ? selected : [selected];
        for (const sel of paths) {
          const filePath = typeof sel === "string" ? sel : (sel as { path: string }).path;
          const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
          await addDirectMedia(filePath, VIDEO_EXTS.has(ext) ? "video" : "image");
        }
      } catch (err) {
        console.error("Failed to pick media:", err);
      }
    } else {
      fileInputRef.current?.click();
    }
  }, [generating, addDirectMedia]);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      await addFilesAsMedia(Array.from(files));
      e.target.value = "";
    },
    [addFilesAsMedia],
  );

  const onPromptChange = useCallback(
    (newContent: string, newRefs: InlineImageRef[]) => {
      updateCard(card.id, { data: { ...data, content: newContent, inlineRefs: newRefs } });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => autoSave.markDirty(card.id), 300);
    },
    [card.id, data, updateCard],
  );

  const setRefImage = useCallback(
    (slotKey: string, entry: RefImageEntry) => {
      const refImages = { ...data.refImages, [slotKey]: entry };
      updateCard(card.id, { data: { ...data, refImages } });
      autoSave.markDirty(card.id);

      if (entry.sourceCardId) {
        const connStore = useConnectionStore.getState();
        if (!connStore.hasConnection(entry.sourceCardId, card.id)) {
          const projectId = useProjectStore.getState().currentProjectId;
          if (projectId) {
            const conn: Connection = {
              id: crypto.randomUUID(),
              projectId,
              sourceCardId: entry.sourceCardId,
              targetCardId: card.id,
              createdAt: new Date().toISOString(),
            };
            connStore.addConnection(conn);
            autoSave.markDirty();
          }
        }
      }
    },
    [card.id, data, updateCard],
  );

  const clearRefImage = useCallback(
    (slotKey: string) => {
      const entry = data.refImages?.[slotKey];
      if (entry?.sourceCardId) {
        const { connections, removeConnection } = useConnectionStore.getState();
        for (const [id, c] of connections) {
          if (c.sourceCardId === entry.sourceCardId && c.targetCardId === card.id) {
            removeConnection(id);
            break;
          }
        }
      }
      const refImages = { ...data.refImages };
      delete refImages[slotKey];
      const keyMap = buildCompactKeyMap(refImages, refSlots);
      const compacted = compactRefImages(refImages, refSlots);

      const { content: newContent, inlineRefs: newInlineRefs } = remapInlineRefs(
        data.content ?? "",
        data.inlineRefs ?? [],
        keyMap,
        slotKey,
      );

      updateCard(card.id, {
        data: { ...data, refImages: compacted, content: newContent, inlineRefs: newInlineRefs },
      });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard, refSlots],
  );

  const handleReorder = useCallback(
    (fromSlotKey: string, toSlotKey: string) => {
      if (!data.refImages?.[fromSlotKey] || !data.refImages?.[toSlotKey]) return;
      if (fromSlotKey === toSlotKey) return;

      const occupiedKeys = refSlots
        .map((s) => s.key)
        .filter((key) => data.refImages![key]);
      const fromIdx = occupiedKeys.indexOf(fromSlotKey);
      const toIdx = occupiedKeys.indexOf(toSlotKey);
      if (fromIdx === -1 || toIdx === -1) return;

      const entries = occupiedKeys.map((k) => data.refImages![k]!);
      const [moved] = entries.splice(fromIdx, 1);
      entries.splice(toIdx, 0, moved!);

      const refImages: Record<string, RefImageEntry> = {};
      entries.forEach((entry, i) => {
        refImages[occupiedKeys[i]!] = entry;
      });

      const { content: newContent, inlineRefs: newInlineRefs } = reorderInlineRefs(
        data.content ?? "",
        data.inlineRefs ?? [],
        occupiedKeys,
        fromIdx,
        toIdx,
      );
      updateCard(card.id, {
        data: { ...data, refImages, content: newContent, inlineRefs: newInlineRefs },
      });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard, refSlots],
  );

  const handleGenerate = useCallback(async () => {
    const rawPrompt = data.content?.trim();
    const displayPrompt = rawPrompt ? toDisplayText(rawPrompt, data.inlineRefs ?? []) : "";
    if (!displayPrompt.trim() || generating) return;

    if (!(await hasApiKey())) {
      useUIStore.getState().addToast({
        type: "warning",
        title: "请先配置 API Key",
        description: "前往设置页面配置你的 API Key",
        action: {
          label: "打开设置",
          onClick: () => useUIStore.getState().toggleSettings(),
        },
        duration: 5000,
      });
      return;
    }

    setCardProgress(card.id, { percent: 0, label: "正在生成…" });
    setError(null);
    useUIStore.getState().setCardError(card.id, null);

    const model = currentModel || "gemini-3.1-pro-preview-thinking-high";

    if (data.result) {
      updateCard(card.id, { data: { ...data, _resultStale: true } });
    }

    const inlineRefs = data.inlineRefs ?? [];
    const hasInlineRefs = inlineRefs.length > 0;

    const imageEntries = refSlots
      .map((slot) => data.refImages?.[slot.key])
      .filter((e): e is RefImageEntry => !!e);

    type ApiContentPart =
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
      | { type: "video_url"; video_url: { url: string } };

    let userContent: ApiContentPart[];

    const allMedia = data.directMedia ?? [];
    const directImageItems = allMedia.filter((m) => m.kind === "image");
    const directVideoItems = allMedia.filter((m) => m.kind === "video");
    const totalMedia = imageEntries.length + allMedia.length;

    if (hasInlineRefs && modelSupportsVision(model)) {
      userContent = await serializeForApi(
        rawPrompt!,
        inlineRefs,
        data.refImages,
        imageOptions,
      ) as ApiContentPart[];

      const inlineUrls = getInlineRefUrls(inlineRefs, data.refImages, imageOptions);
      for (const entry of imageEntries) {
        if (inlineUrls.has(entry.url)) continue;
        const dataUrl = await getBase64ForApi(entry.url);
        userContent.unshift({ type: "image_url", image_url: { url: dataUrl } });
      }
      for (const img of directImageItems) {
        const dataUrl = await getBase64ForApi(img.url);
        userContent.unshift({ type: "image_url", image_url: { url: dataUrl } });
      }
      for (const vid of directVideoItems) {
        const dataUrl = await getBase64ForApi(vid.url);
        userContent.unshift({ type: "video_url", video_url: { url: dataUrl } });
      }
    } else {
      userContent = [];
      if (modelSupportsVision(model)) {
        for (const img of imageEntries) {
          const dataUrl = await getBase64ForApi(img.url);
          userContent.push({ type: "image_url", image_url: { url: dataUrl } });
        }
        for (const img of directImageItems) {
          const dataUrl = await getBase64ForApi(img.url);
          userContent.push({ type: "image_url", image_url: { url: dataUrl } });
        }
        for (const vid of directVideoItems) {
          const dataUrl = await getBase64ForApi(vid.url);
          userContent.push({ type: "video_url", video_url: { url: dataUrl } });
        }
      } else if (totalMedia > 0) {
        useUIStore.getState().addToast({
          type: "warning",
          title: "当前模型不支持媒体输入",
          description: `${model} 不支持视觉能力，已忽略参考图/视频。`,
          duration: 5000,
        });
      }
      userContent.push({ type: "text", text: displayPrompt });
    }

    const systemPrompt = data._systemPrompt || "你是一个有帮助的 AI 助手，请用中文回复。请直接回答用户的问题。";
    const hasMedia = userContent.some((p) => p.type === "image_url" || p.type === "video_url");

    const unifiedUserContent: UnifiedContentPart[] = hasMedia
      ? userContent.map((p): UnifiedContentPart => {
          if (p.type === "text") return { type: "text", text: p.text };
          if (p.type === "image_url") return { type: "image", url: p.image_url.url };
          if (p.type === "video_url") return { type: "video", url: p.video_url.url };
          return { type: "text", text: "" };
        })
      : [{ type: "text", text: displayPrompt }];

    const unifiedMessages: UnifiedMessage[] = [
      { role: "user", content: unifiedUserContent },
    ];

    try {
      const provider = modelService.resolveProvider(model, data.provider);
      const resp = await provider.chat({
        model,
        systemPrompt: systemPrompt || "You are a helpful AI assistant.",
        messages: unifiedMessages,
        maxTokens: 4096,
      });

      const result = resp.content ?? "（无回复 — 模型未返回任何内容）";

      useCardStore.getState().updateCard(card.id, {
        data: { ...data, result, _resultStale: false },
      });
      autoSave.markDirty(card.id);
      useUIStore.getState().addToast({
        type: "success",
        title: "生成完成",
        description: `${model} 已完成回复`,
        duration: 3000,
      });
    } catch (err) {
      console.error("[ChatEditor] AI 请求异常:", err);
      const msg = err instanceof Error ? err.message : String(err);
      const errMsg = friendlyError(msg);
      setError(errMsg);
      useUIStore.getState().setCardError(card.id, errMsg);
    } finally {
      setCardProgress(card.id, null);
    }
  }, [data, card.id, generating, updateCard, currentModel, setCardProgress, refSlots, imageOptions]);

  const hasContent = !!(data.content?.trim());
  const isLocked = !!data._locked;

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      {refSlots.some((s) => data.refImages?.[s.key]) && (
        <div className="flex shrink-0 flex-wrap gap-2">
          {refSlots.map((slot, idx) => {
            const entry = data.refImages?.[slot.key];
            if (!entry) return null;
            return (
              <RefImageSlot
                key={slot.key}
                label={slot.label}
                description={slot.description}
                entry={entry}
                onImage={(e) => setRefImage(slot.key, e)}
                onClear={() => clearRefImage(slot.key)}
                onRefClick={() => {
                  const opt = imageOptions.find((o) => o.id === `slot:${slot.key}`);
                  if (opt) promptRef.current?.insertRef(opt);
                }}
                onReorder={(fromKey) => handleReorder(fromKey, slot.key)}
                disabled={generating}
                targetCardId={card.id}
                slotKey={slot.key}
                index={idx}
                highlighted={hoveredRefId === `slot:${slot.key}`}
              />
            );
          })}
        </div>
      )}

      {directMedia.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {directMedia.map((item, idx) => (
            <div key={idx} className="group relative">
              {item.kind === "video" ? (
                <div className="relative h-14 w-20 overflow-hidden rounded-lg border border-border bg-black/5">
                  <video
                    src={item.displayUrl}
                    className="h-full w-full object-cover"
                    preload="metadata"
                    muted
                  />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Video className="h-4 w-4 text-white drop-shadow-md" />
                  </div>
                </div>
              ) : (
                <img
                  src={item.displayUrl}
                  alt=""
                  className="h-14 w-14 rounded-lg border border-border object-cover"
                />
              )}
              <button
                onClick={() => removeDirectMedia(idx)}
                className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground group-hover:flex"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {isLocked ? (
        <div className="flex flex-1 items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2">
          <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">{data._label || "模板分析节点"}</p>
            {data._description && (
              <p className="text-[11px] text-muted-foreground">{data._description}</p>
            )}
          </div>
        </div>
      ) : (
        <PromptTextarea
          ref={promptRef}
          value={data.content ?? ""}
          inlineRefs={data.inlineRefs ?? []}
          imageOptions={imageOptions}
          onChange={onPromptChange}
          placeholder="输入提示词，按 @ 引用图片…"
          disabled={generating}
          onHoverRef={setHoveredRefId}
          onPasteImage={addFilesAsMedia}
          onDropImage={addFilesAsMedia}
        />
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-destructive">{error}</p>
          <button
            onClick={() => { setError(null); useUIStore.getState().setCardError(card.id, null); }}
            className="shrink-0 rounded p-0.5 text-destructive/60 hover:bg-destructive/10 hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="flex shrink-0 items-center gap-2">
        <ModelSelector
          capability="CHAT"
          value={currentModel}
          providerId={data.provider}
          onChange={handleModelChange}
        />
        <button
          onClick={handlePickMedia}
          disabled={generating}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          title="上传图片/视频"
        >
          <Paperclip className="h-4 w-4" />
        </button>
        {!isTauri && (
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*,.heic,.heif,.mp4,.webm,.mov,.avi,.mkv"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />
        )}
        <div className="flex-1" />
        <button
          onClick={handleGenerate}
          disabled={generating || !hasContent}
          className={cn(
            "flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors",
            "bg-primary text-primary-foreground hover:bg-primary/90",
            (generating || !hasContent) && "cursor-not-allowed opacity-40",
          )}
        >
          {generating ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {isLocked ? "分析中…" : "生成中…"}
            </>
          ) : data.result ? (
            <>
              <RefreshCw className="h-3.5 w-3.5" />
              {isLocked ? "重新分析" : "重新生成"}
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5" />
              {isLocked ? "分析" : "生成"}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
