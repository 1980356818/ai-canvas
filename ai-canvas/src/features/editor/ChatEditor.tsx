import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { Sparkles, RefreshCw, Loader2, Lock, X, AlertCircle, Paperclip, Video } from "lucide-react";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard, Connection } from "@/types";
import { useUIStore } from "@/stores/uiStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { autoSave } from "@/lib/autoSave";
import { CHAT_EDITOR_DEFAULT_SYSTEM_PROMPT } from "@/lib/systemPrompts";
import { hasApiKey } from "@/platform";
import type { UnifiedMessage, UnifiedContentPart } from "@/providers/types";
import "@/providers";
import { persistImage, getDisplayUrl, normalizeToStoragePath } from "@/lib/media";
import { uploadMediaBatch } from "@/platform/media";
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
import { disconnectCardPairAndCleanup } from "@/lib/referenceConsistency";
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

interface VideoRefEntry {
  url: string;
  sourceCardId?: string;
}

interface ChatData {
  content?: string;
  result?: string;
  model?: string;
  provider?: string;
  refImages?: Record<string, RefImageEntry>;
  inlineRefs?: InlineImageRef[];
  directMedia?: MediaAttachment[];
  refVideos?: VideoRefEntry[];
  upstreamTexts?: Record<string, string>;
  _locked?: boolean;
  _systemPrompt?: string;
  _label?: string;
  _description?: string;
  _resultStale?: boolean;
}

export default function ChatEditor({ card }: { card: CanvasCard }) {
  const updateCard = useCardStore((s) => s.updateCard);
  const updateCardData = useCardStore((s) => s.updateCardData);
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
      const saved = useSettingsStore.getState().getLastModel("chat");
      if (saved) {
        setCurrentModel(saved.modelId);
        updateCard(card.id, { data: { ...data, model: saved.modelId, provider: saved.providerId } });
      } else {
        modelService.getDefaultChatModel().then(({ modelId, providerId }) => {
          setCurrentModel(modelId);
          updateCard(card.id, { data: { ...data, model: modelId, provider: providerId } });
        });
      }
    }
  }, [data.model]);

  useEffect(() => {
    const d = card.data as Record<string, unknown>;
    if (d.upstreamContext && !d.upstreamTexts) {
      const srcId = (d.upstreamCardId as string) || "legacy";
      updateCard(card.id, {
        data: {
          ...card.data,
          upstreamTexts: { [srcId]: d.upstreamContext as string },
          upstreamContext: undefined,
        },
      });
      autoSave.markDirty(card.id);
    }
  }, []);

  const refSlots = useMemo(() => {
    const slots = getRefSlotsForChatModel(currentModel);
    if (data._locked && slots.length === 0) {
      return getRefSlotsForChatModel("");
    }
    return slots;
  }, [currentModel, data._locked]);

  const [hoveredRefId, setHoveredRefId] = useState<string | null>(null);

  const imageOptions = useImageRefSources(card.id, refSlots, data.refImages, undefined, data.refVideos);

  const handleModelChange = useCallback(
    (modelId: string, providerId: string) => {
      setCurrentModel(modelId);
      updateCard(card.id, { data: { ...data, model: modelId, provider: providerId } });
      autoSave.markDirty(card.id);
      useSettingsStore.getState().setLastModel("chat", modelId, providerId);
    },
    [card.id, data, updateCard],
  );

  const addDirectMedia = useCallback(
    async (src: string, kind: "image" | "video") => {
      if (generating) return;
      const pid = card.projectId;
      try {
        const storagePath = normalizeToStoragePath(src);
        let url: string;
        if (storagePath) {
          url = storagePath;
        } else {
          const { localPath } = await persistImage(src, undefined, pid);
          url = localPath;
        }
        if (kind === "video") {
          const videos = [...(data.refVideos ?? []), { url }];
          updateCard(card.id, { data: { ...data, refVideos: videos } });
        } else {
          const newMedia = [...directMedia, { url, displayUrl: getDisplayUrl(url), kind }];
          updateCard(card.id, { data: { ...data, directMedia: newMedia } });
        }
        autoSave.markDirty(card.id);
      } catch (err) {
        console.error(`Failed to add ${kind}:`, err);
      }
    },
    [card.id, card.projectId, data, directMedia, generating, updateCard],
  );

  const addFilesAsMedia = useCallback(
    async (files: File[]) => {
      if (generating) return;
      const pid = card.projectId;
      const newMedia = [...directMedia];
      const newVideos = [...(data.refVideos ?? [])];
      let changed = false;
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
          if (isVideo) {
            newVideos.push({ url: localPath });
          } else {
            newMedia.push({ url: localPath, displayUrl: getDisplayUrl(localPath), kind: "image" });
          }
          changed = true;
        } catch { /* skip */ }
      }
      if (changed) {
        updateCard(card.id, {
          data: {
            ...data,
            directMedia: newMedia,
            refVideos: newVideos.length > 0 ? newVideos : undefined,
          },
        });
        autoSave.markDirty(card.id);
      }
    },
    [card.id, card.projectId, data, directMedia, generating, updateCard],
  );

  const removeDirectMedia = useCallback(
    (idx: number) => {
      const newMedia = directMedia.filter((_, i) => i !== idx);
      updateCard(card.id, { data: { ...data, directMedia: newMedia } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, directMedia, updateCard],
  );

  const disconnectVideo = useCallback(
    (index: number) => {
      const entry = data.refVideos?.[index];
      if (entry?.sourceCardId) {
        disconnectCardPairAndCleanup(entry.sourceCardId, card.id);
      }
    },
    [data.refVideos, card.id],
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
          const conn: Connection = {
            id: crypto.randomUUID(),
            projectId: card.projectId,
            sourceCardId: entry.sourceCardId,
            targetCardId: card.id,
            createdAt: new Date().toISOString(),
          };
          connStore.addConnection(conn);
          autoSave.markDirty();
        }
      }
    },
    [card.id, data, updateCard],
  );

  const clearRefImage = useCallback(
    (slotKey: string) => {
      const entry = data.refImages?.[slotKey];
      if (entry?.sourceCardId) {
        // Removing the connection synchronously triggers reference cleanup
        // for the disconnected source via the connection-store lifecycle hook.
        disconnectCardPairAndCleanup(entry.sourceCardId, card.id, { markDirty: false });
      }
      const latest = useCardStore.getState().getCard(card.id)?.data as ChatData | undefined;
      const refImages = { ...(latest?.refImages ?? {}) };
      delete refImages[slotKey];
      const keyMap = buildCompactKeyMap(refImages, refSlots);
      const compacted = compactRefImages(refImages, refSlots);

      const { content: newContent, inlineRefs: newInlineRefs } = remapInlineRefs(
        latest?.content ?? "",
        latest?.inlineRefs ?? [],
        keyMap,
        slotKey,
      );

      updateCardData(card.id, {
        refImages: Object.keys(compacted).length > 0 ? compacted : undefined,
        content: newContent,
        inlineRefs: newInlineRefs.length > 0 ? newInlineRefs : undefined,
      });
      autoSave.markDirty(card.id);
    },
    [card.id, data.refImages, updateCardData, refSlots],
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
    const rawUpstream = (data as Record<string, unknown>).upstreamTexts as
      Record<string, string> | undefined;
    const hasUpstreamText = rawUpstream && Object.keys(rawUpstream).length > 0;
    if ((!displayPrompt.trim() && !hasUpstreamText) || generating) return;

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

    const model = currentModel || "gemini-3.1-pro-preview";

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
      | { type: "image_url"; image_url: { url: string } };

    let userContent: ApiContentPart[];

    const directImageItems = (data.directMedia ?? []).filter((m) => m.kind === "image");
    const refVideoEntries = data.refVideos ?? [];
    const totalMedia = imageEntries.length + directImageItems.length + refVideoEntries.length;

    if (hasInlineRefs && modelSupportsVision(model)) {
      userContent = await serializeForApi(
        rawPrompt!,
        inlineRefs,
        data.refImages,
        imageOptions,
      ) as ApiContentPart[];

      // 全部 ref 媒体并行上传 —— 后端 MAIN_SEMAPHORE(4) + sha256 单飞兜底, 不会
      // 打爆服务端。N 张图首传从 N×t 降到 max(N,4)×t。
      //
      // 顺序契约: 原代码用 unshift 把每个 ref 塞到 userContent 头部, 等价于
      // "保留遍历顺序的逆序排在前面"。这里先收集所有 part, 再按 unshift 历史
      // 行为做一次 reverse + unshift, 等同于挨个 unshift 的最终结果。
      const inlineUrls = getInlineRefUrls(inlineRefs, data.refImages, imageOptions);
      const refsToUpload = [
        ...imageEntries.filter((e) => !inlineUrls.has(e.url)).map((e) => e.url),
        ...directImageItems.map((m) => m.url),
        ...refVideoEntries.filter((v) => !inlineUrls.has(v.url)).map((v) => v.url),
      ];
      // 进度反馈到卡片:用户挂多张图 / 大视频 ref 时显示 "上传 N/M…"
      const uploadedRefs = await uploadMediaBatch(refsToUpload, {
        onProgress: ({ uploaded, total }) => {
          setCardProgress(card.id, {
            percent: 0,
            label: `上传参考媒体 ${uploaded}/${total}…`,
          });
        },
      });
      // 逐个 unshift 等于:把数组反转后塞到头部 (后 unshift 的被推到更前)
      uploadedRefs
        .slice()
        .reverse()
        .forEach((dataUrl) => {
          userContent.unshift({ type: "image_url", image_url: { url: dataUrl } });
        });
    } else {
      userContent = [];
      if (modelSupportsVision(model)) {
        // 同样并行上传 + 保序 push (这条分支不走 unshift, 按原遍历顺序 append)
        const allMedia = [
          ...imageEntries.map((e) => e.url),
          ...directImageItems.map((m) => m.url),
          ...refVideoEntries.map((v) => v.url),
        ];
        const uploaded = await uploadMediaBatch(allMedia, {
          onProgress: ({ uploaded, total }) => {
            setCardProgress(card.id, {
              percent: 0,
              label: `上传媒体 ${uploaded}/${total}…`,
            });
          },
        });
        uploaded.forEach((dataUrl) => {
          userContent.push({ type: "image_url", image_url: { url: dataUrl } });
        });
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

    const rawUpstreamTexts = (data as Record<string, unknown>).upstreamTexts as
      Record<string, string> | undefined;
    const upstreamEntries = rawUpstreamTexts ? Object.entries(rawUpstreamTexts) : [];

    let contextPrefix = "";
    if (upstreamEntries.length > 0) {
      const cs = useCardStore.getState();
      const sections = upstreamEntries.map(([cid, txt]) => {
        const label = cs.getCard(cid)?.title || "上游节点";
        return `## ${label}\n${txt}`;
      });
      contextPrefix =
        "<upstream_context>\n" +
        sections.join("\n\n") +
        "\n</upstream_context>\n\n";
    }

    const systemPrompt = contextPrefix
      + (data._systemPrompt || CHAT_EDITOR_DEFAULT_SYSTEM_PROMPT);
    const hasMedia = userContent.some((p) => p.type === "image_url");

    const unifiedUserContent: UnifiedContentPart[] = hasMedia
      ? userContent.map((p): UnifiedContentPart => {
          if (p.type === "text") return { type: "text", text: p.text };
          if (p.type === "image_url") return { type: "image", url: p.image_url.url };
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
        systemPrompt: systemPrompt || CHAT_EDITOR_DEFAULT_SYSTEM_PROMPT,
        messages: unifiedMessages,
        maxTokens: 65536,
      });

      let result = resp.content ?? "（无回复 — 模型未返回任何内容）";
      if (resp.finishReason === "length" && resp.content) {
        result += "\n\n---\n⚠️ *回复因达到输出上限被截断，可尝试拆分提问以获取完整内容。*";
      }

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

  const hasUpstream = !!(
    (data as Record<string, unknown>).upstreamTexts &&
    Object.keys((data as Record<string, unknown>).upstreamTexts as Record<string, string>).length > 0
  );
  const hasContent = !!(data.content?.trim()) || hasUpstream;
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

      {data.refVideos && data.refVideos.length > 0 && (
        <div className="shrink-0 rounded-lg border border-dashed border-primary/25 bg-primary/[0.03] p-2">
          <div className="mb-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
            <Video className="h-3 w-3" />
            参考视频 · 连线的视频素材 ({data.refVideos.length}/3)
          </div>
          <div className="flex flex-wrap gap-2">
            {data.refVideos.map((entry, idx) => (
              <div
                key={entry.sourceCardId ?? idx}
                className="relative aspect-square w-[96px] shrink-0 cursor-pointer"
                onClick={() => {
                  const opt = imageOptions.find((o) => o.id === `video:${idx}`);
                  if (opt) promptRef.current?.insertRef(opt);
                }}
                title="点击插入引用到提示词"
              >
                <div className="h-full w-full overflow-hidden rounded-lg border border-input bg-muted/30 transition-colors hover:border-primary/60 hover:shadow-sm">
                  <video
                    src={getDisplayUrl(entry.url)}
                    muted
                    playsInline
                    preload="metadata"
                    className="h-full w-full object-cover"
                    onLoadedMetadata={(e) => {
                      (e.target as HTMLVideoElement).currentTime = 0.1;
                    }}
                  />
                </div>
                <span className="absolute left-0 top-0 z-10 flex h-5 w-5 -translate-x-1/4 -translate-y-1/4 items-center justify-center rounded-full bg-black/70 text-[10px] font-bold text-white shadow-sm">
                  {idx + 1}
                </span>
                <span className="absolute bottom-0.5 left-0.5 z-10 flex items-center gap-0.5 rounded bg-black/60 px-1 py-px text-[9px] text-white">
                  <Video className="h-2 w-2" />
                  {entry.sourceCardId ? (useCardStore.getState().getCard(entry.sourceCardId)?.title || "AI 视频") : `视频${idx + 1}`}
                </span>
                {!generating && (
                  <button
                    onClick={(e) => { e.stopPropagation(); disconnectVideo(idx); }}
                    className="absolute right-1 top-1 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80"
                    title="断开视频连线"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {directMedia.some((m) => m.kind === "image") && (
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {directMedia.map((item, idx) => {
            if (item.kind !== "image") return null;
            const src = item.displayUrl || getDisplayUrl(item.url);
            return (
            <div key={idx} className="group relative">
              <img
                src={src}
                alt=""
                className="h-14 w-14 rounded-lg border border-border object-cover"
                loading="lazy"
                decoding="async"
              />
              <button
                onClick={() => removeDirectMedia(idx)}
                className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground group-hover:flex"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
            );
          })}
        </div>
      )}

      {data.upstreamTexts && Object.keys(data.upstreamTexts).length > 0 && (
        <div className="flex shrink-0 flex-col gap-1 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2">
          <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
            <Paperclip className="h-3 w-3" />
            <span>引用 {Object.keys(data.upstreamTexts).length} 个上游输出</span>
          </div>
          {Object.entries(data.upstreamTexts).map(([srcId, txt]) => {
            const srcCard = useCardStore.getState().getCard(srcId);
            const label = srcCard?.title || "上游节点";
            return (
              <div
                key={srcId}
                className="flex items-center gap-1.5 rounded-md bg-background/60 px-2 py-1 text-[11px]"
              >
                <span className="min-w-0 flex-1 truncate text-foreground/80">
                  <span className="font-medium text-foreground">{label}</span>
                  {" · "}
                  {txt.length > 60 ? txt.slice(0, 60) + "…" : txt}
                  {` (${txt.length}字)`}
                </span>
                <button
                  onClick={() => disconnectCardPairAndCleanup(srcId, card.id)}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
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
          onClick={() => {
            if (!hasContent && !generating) {
              useUIStore.getState().addToast({
                type: "info",
                title: "请先输入提示词",
                description: "在上方输入框中输入你的问题或指令",
                duration: 3000,
              });
              return;
            }
            handleGenerate();
          }}
          disabled={generating}
          className={cn(
            "flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors",
            "bg-primary text-primary-foreground hover:bg-primary/90",
            generating && "cursor-not-allowed opacity-40",
            !generating && !hasContent && "opacity-60",
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
