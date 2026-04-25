import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { Sparkles, Loader2, RefreshCw, ArrowDownLeft, Lock, X, AlertCircle, ImageIcon, Music, Video } from "lucide-react";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard } from "@/types";
import { useUIStore } from "@/stores/uiStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { autoSave } from "@/lib/autoSave";
import { hasApiKey } from "@/platform";
import { modelService } from "@/services/models";
import { scheduleBackgroundSave, getBase64ForApi, getDisplayUrl } from "@/lib/media";
import { useProjectStore } from "@/stores/projectStore";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { useConnectionStore } from "@/stores/connectionStore";
import { useImageRefSources } from "@/hooks/useImageRefSources";
import { type InlineImageRef, toDisplayText } from "@/lib/promptSerializer";
import { getRefSlotsForVideoModel, compactRefImages, type RefImageEntry } from "@/config/model-ref-images";
import ModelSelector from "./ModelSelector";
import RefImageSlot from "./RefImageSlot";
import SizeCombo from "./SizeCombo";
import PromptTextarea, { type PromptTextareaHandle } from "./PromptTextarea";
import { normalizeImageSize } from "@/shared/constants";
import { isSeedanceModel } from "@/providers/comfly/models";

interface VideoFrameRef {
  url: string;
  sourceCardId: string;
}

const MAX_AUDIO_SLOTS = 3;

interface AudioRefEntry {
  url: string;
  filename: string;
  duration?: number;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type VideoImageMode = "text" | "firstFrame" | "firstLastFrame" | "reference";

function resolveImageMode(data: { imageMode?: string; refFrames?: unknown[] }): VideoImageMode {
  const raw = data.imageMode;
  if (raw === "text" || raw === "firstFrame" || raw === "firstLastFrame" || raw === "reference") return raw;
  if (raw === "frame") {
    const len = data.refFrames?.length ?? 0;
    return len <= 1 ? "firstFrame" : "firstLastFrame";
  }
  return "reference";
}

interface VideoData {
  content?: string;
  videoUrl?: string;
  model?: string;
  provider?: string;
  size?: string;
  upstreamTexts?: Record<string, string>;
  inlineRefs?: InlineImageRef[];
  /** @deprecated use refFrames instead */
  upstreamImageUrl?: string;
  refFrames?: VideoFrameRef[];
  upstreamCardId?: string;
  _locked?: boolean;
  _label?: string;
  _description?: string;
  duration?: number;
  resolution?: string;
  generateAudio?: boolean;
  imageMode?: VideoImageMode;
  refImages?: Record<string, RefImageEntry>;
  refAudios?: AudioRefEntry[];
  refVideos?: VideoRefEntry[];
}

interface VideoRefEntry {
  url: string;
  sourceCardId?: string;
}

interface AudioRefWithSource extends AudioRefEntry {
  sourceCardId?: string;
}

function buildFinalPrompt(data: VideoData): string {
  const parts: string[] = [];
  if (data.upstreamTexts) {
    for (const text of Object.values(data.upstreamTexts)) {
      if (text.trim()) parts.push(text.trim());
    }
  }
  if (data.content?.trim()) {
    const display = toDisplayText(data.content.trim(), data.inlineRefs ?? []);
    parts.push(display);
  }
  return parts.join("\n\n");
}

function getCardTitle(cardId: string): string {
  const card = useCardStore.getState().getCard(cardId);
  if (!card) return "未知卡片";
  if (card.title) return card.title;
  switch (card.type) {
    case "text": return "文字卡片";
    case "sticky_note": return "便签";
    case "ai_chat": return "AI 对话";
    default: return card.type;
  }
}

export default function VideoEditor({ card }: { card: CanvasCard }) {
  const updateCard = useCardStore((s) => s.updateCard);
  const setCardProgress = useUIStore((s) => s.setCardProgress);
  const generating = useUIStore((s) => s.generatingCards.has(card.id));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const promptRef = useRef<PromptTextareaHandle>(null);
  const [currentModel, setCurrentModel] = useState("");
  const [currentSize, setCurrentSize] = useState(() => normalizeImageSize((card.data as VideoData).size));
  const [error, setError] = useState<string | null>(null);
  const data = card.data as VideoData;
  const imageMode: VideoImageMode = resolveImageMode(data);

  const refSlots = useMemo(
    () => getRefSlotsForVideoModel(currentModel, imageMode),
    [currentModel, imageMode],
  );

  const upstreamEntries = useMemo(
    () => Object.entries(data.upstreamTexts || {}),
    [data.upstreamTexts],
  );
  const hasUpstream = upstreamEntries.length > 0;

  const finalPrompt = useMemo(() => buildFinalPrompt(data), [data]);
  const canGenerate = finalPrompt.length > 0;

  useEffect(() => {
    if (data.model && data.provider) {
      setCurrentModel(data.model);
    } else if (data.model) {
      setCurrentModel(data.model);
      const p = modelService.tryResolveProvider(data.model);
      if (p) updateCard(card.id, { data: { ...data, provider: p.descriptor.id } });
    } else {
      const saved = useSettingsStore.getState().getLastModel("video");
      if (saved) {
        setCurrentModel(saved.modelId);
        updateCard(card.id, { data: { ...data, model: saved.modelId, provider: saved.providerId } });
      } else {
        modelService.getDefaultVideoModel().then(({ modelId, providerId }) => {
          setCurrentModel(modelId);
          updateCard(card.id, { data: { ...data, model: modelId, provider: providerId } });
        });
      }
    }
  }, [data.model]);

  const frames = useMemo(() => {
    if (data.refFrames && data.refFrames.length > 0) return data.refFrames;
    if (data.upstreamImageUrl) {
      return [{ url: data.upstreamImageUrl, sourceCardId: data.upstreamCardId ?? "" }];
    }
    return [];
  }, [data.refFrames, data.upstreamImageUrl, data.upstreamCardId]);

  const imageOptions = useImageRefSources(card.id, refSlots, data.refImages, data.refAudios, data.refVideos);

  const setRefImage = useCallback(
    (slotKey: string, entry: RefImageEntry) => {
      const refImages = { ...data.refImages, [slotKey]: entry };
      updateCard(card.id, { data: { ...data, refImages } });
      autoSave.markDirty(card.id);
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
      const compacted = compactRefImages(refImages, refSlots);
      updateCard(card.id, { data: { ...data, refImages: compacted } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, refSlots, updateCard],
  );

  const disconnectCards = useCallback(
    (sourceCardIds: string[]) => {
      if (sourceCardIds.length === 0) return;
      const { connections, removeConnection } = useConnectionStore.getState();
      for (const sid of sourceCardIds) {
        if (!sid) continue;
        for (const [id, c] of connections) {
          if (c.sourceCardId === sid && c.targetCardId === card.id) {
            removeConnection(id);
            break;
          }
        }
      }
    },
    [card.id],
  );

  const collectAllSourceCardIds = useCallback((): string[] => {
    const ids: string[] = [];
    if (data.refImages) {
      for (const e of Object.values(data.refImages)) if (e.sourceCardId) ids.push(e.sourceCardId);
    }
    for (const f of frames) if (f.sourceCardId) ids.push(f.sourceCardId);
    if (data.refAudios) {
      for (const a of data.refAudios as Array<{ sourceCardId?: string }>) if (a.sourceCardId) ids.push(a.sourceCardId);
    }
    if (data.refVideos) {
      for (const v of data.refVideos) if (v.sourceCardId) ids.push(v.sourceCardId);
    }
    return ids;
  }, [data.refImages, data.refAudios, data.refVideos, frames]);

  const handleImageModeChange = useCallback(
    (newMode: VideoImageMode) => {
      if (imageMode === newMode) return;
      const newData: Record<string, unknown> = { ...data, imageMode: newMode };

      if (newMode === "text") {
        disconnectCards(collectAllSourceCardIds());
        newData.refFrames = undefined;
        newData.refImages = undefined;
        newData.refAudios = undefined;
        newData.refVideos = undefined;
      } else if (newMode === "firstFrame") {
        const firstImage = frames[0] ?? (data.refImages && Object.values(data.refImages)[0]);
        const droppedIds = collectAllSourceCardIds();
        const keptFrame = firstImage
          ? { url: firstImage.url, sourceCardId: firstImage.sourceCardId ?? "" }
          : undefined;
        if (keptFrame?.sourceCardId) {
          const idx = droppedIds.indexOf(keptFrame.sourceCardId);
          if (idx >= 0) droppedIds.splice(idx, 1);
        }
        disconnectCards(droppedIds);
        newData.refFrames = keptFrame ? [keptFrame] : undefined;
        newData.refImages = undefined;
        newData.refAudios = undefined;
        newData.refVideos = undefined;
      } else if (newMode === "firstLastFrame") {
        const keptFrames: VideoFrameRef[] = [];
        if (frames.length > 0) {
          keptFrames.push(...frames.slice(0, 2));
        } else if (data.refImages) {
          const slots = getRefSlotsForVideoModel(currentModel, "reference");
          const entries = slots.map((s) => data.refImages?.[s.key]).filter((e): e is RefImageEntry => !!e);
          for (const e of entries.slice(0, 2)) {
            keptFrames.push({ url: e.url, sourceCardId: e.sourceCardId ?? "" });
          }
        }
        const keptIds = new Set(keptFrames.map((f) => f.sourceCardId).filter(Boolean));
        const droppedIds = collectAllSourceCardIds().filter((id) => !keptIds.has(id));
        disconnectCards(droppedIds);
        newData.refFrames = keptFrames.length > 0 ? keptFrames : undefined;
        newData.refImages = undefined;
        newData.refAudios = undefined;
        newData.refVideos = undefined;
      } else {
        const refImages: Record<string, RefImageEntry> = {};
        (frames ?? []).forEach((f, i) => {
          refImages[`refImage${i}`] = { url: f.url, sourceCardId: f.sourceCardId, sourceType: "card" };
        });
        newData.refImages = Object.keys(refImages).length > 0 ? refImages : undefined;
        newData.refFrames = undefined;
      }

      updateCard(card.id, { data: newData });
      autoSave.markDirty(card.id);
    },
    [imageMode, data, frames, currentModel, card.id, updateCard, disconnectCards, collectAllSourceCardIds],
  );

  const disconnectAudio = useCallback(
    (index: number) => {
      const entry = (data.refAudios as AudioRefWithSource[] | undefined)?.[index];
      if (entry?.sourceCardId) {
        const { connections, removeConnection } = useConnectionStore.getState();
        for (const [id, c] of connections) {
          if (c.sourceCardId === entry.sourceCardId && c.targetCardId === card.id) {
            removeConnection(id);
            break;
          }
        }
      }
    },
    [data.refAudios, card.id],
  );

  const disconnectVideo = useCallback(
    (index: number) => {
      const entry = data.refVideos?.[index];
      if (entry?.sourceCardId) {
        const { connections, removeConnection } = useConnectionStore.getState();
        for (const [id, c] of connections) {
          if (c.sourceCardId === entry.sourceCardId && c.targetCardId === card.id) {
            removeConnection(id);
            break;
          }
        }
      }
    },
    [data.refVideos, card.id],
  );

  const handleModelChange = useCallback(
    (modelId: string, providerId: string) => {
      setCurrentModel(modelId);
      updateCard(card.id, { data: { ...data, model: modelId, provider: providerId } });
      autoSave.markDirty(card.id);
      useSettingsStore.getState().setLastModel("video", modelId, providerId);
    },
    [card.id, data, updateCard],
  );

  const handleSizeChange = useCallback(
    (size: string) => {
      setCurrentSize(size);
      updateCard(card.id, { data: { ...data, size } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );


  const onPromptChange = useCallback(
    (newContent: string, newRefs: InlineImageRef[]) => {
      updateCard(card.id, { data: { ...data, content: newContent, inlineRefs: newRefs } });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => autoSave.markDirty(card.id), 300);
    },
    [card.id, data, updateCard],
  );

  const removeUpstreamEntry = useCallback(
    (sourceCardId: string) => {
      const { connections, removeConnection } = useConnectionStore.getState();
      for (const [id, c] of connections) {
        if (c.sourceCardId === sourceCardId && c.targetCardId === card.id) {
          removeConnection(id);
          break;
        }
      }
    },
    [card.id],
  );

  const removeFrame = useCallback(
    (index: number) => {
      const frame = frames[index];
      if (!frame) return;

      if (frame.sourceCardId) {
        const { connections, removeConnection } = useConnectionStore.getState();
        for (const [id, c] of connections) {
          if (c.sourceCardId === frame.sourceCardId && c.targetCardId === card.id) {
            removeConnection(id);
            break;
          }
        }
      }

      const newFrames = frames.filter((_, i) => i !== index);
      updateCard(card.id, {
        data: {
          ...data,
          refFrames: newFrames.length > 0 ? newFrames : undefined,
          upstreamImageUrl: undefined,
        },
      });
      autoSave.markDirty(card.id);
    },
    [card.id, data, frames, updateCard],
  );

  const handleGenerate = useCallback(async () => {
    const prompt = buildFinalPrompt(data);
    if (!prompt || generating) return;

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

    setCardProgress(card.id, { percent: 0, label: "正在提交请求…" });
    setError(null);
    useUIStore.getState().setCardError(card.id, null);

    try {
      const provider = modelService.resolveProvider(currentModel, data.provider);
      if (!provider.generateVideo) {
        throw new Error("当前 Provider 不支持视频生成");
      }

      const referenceImages: Array<{ url: string; role: string }> = [];
      const referenceAudios: Array<{ url: string; role: string }> = [];
      const referenceVideos: Array<{ url: string; role: string }> = [];

      if (imageMode === "firstFrame") {
        if (frames[0]) {
          const dataUrl = await getBase64ForApi(frames[0].url);
          referenceImages.push({ url: dataUrl, role: "firstFrame" });
        }
      } else if (imageMode === "firstLastFrame") {
        for (let i = 0; i < frames.length; i++) {
          const dataUrl = await getBase64ForApi(frames[i]!.url);
          referenceImages.push({ url: dataUrl, role: i === 0 ? "firstFrame" : "lastFrame" });
        }
      } else if (imageMode === "reference") {
        for (const slot of refSlots) {
          const entry = data.refImages?.[slot.key];
          if (entry) {
            const dataUrl = await getBase64ForApi(entry.url);
            referenceImages.push({ url: dataUrl, role: "referenceImage" });
          }
        }
        if (data.refAudios?.length) {
          for (const entry of data.refAudios) {
            const dataUrl = await getBase64ForApi(entry.url);
            referenceAudios.push({ url: dataUrl, role: "referenceAudio" });
          }
        }
        if (data.refVideos?.length) {
          for (const entry of data.refVideos) {
            const dataUrl = await getBase64ForApi(entry.url);
            referenceVideos.push({ url: dataUrl, role: "referenceVideo" });
          }
        }
        if (
          isSeedanceModel(currentModel) &&
          referenceAudios.length > 0 &&
          referenceImages.length === 0 &&
          referenceVideos.length === 0
        ) {
          useUIStore.getState().addToast({
            type: "warning",
            title: "参考音频不能单独使用",
            description: "Seedance 要求参考音频必须搭配参考图或参考视频一起使用，请先添加图片或视频素材",
            duration: 5000,
          });
          setCardProgress(card.id, null);
          return;
        }
      }

      const result = await provider.generateVideo({
        prompt,
        model: currentModel || undefined,
        size: currentSize,
        referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
        referenceAudios: referenceAudios.length > 0 ? referenceAudios : undefined,
        referenceVideos: referenceVideos.length > 0 ? referenceVideos : undefined,
        onProgress: (p) => {
          setCardProgress(card.id, { percent: p.percent, label: p.label });
        },
      });

      updateCard(card.id, { data: { ...data, videoUrl: result.url } });
      autoSave.markDirty(card.id);

      const isRemote = result.url.startsWith("http://") || result.url.startsWith("https://");
      if (isRemote) {
        const pid = useProjectStore.getState().currentProjectId ?? undefined;
        scheduleBackgroundSave(card.id, result.url, "videoUrl", pid);
        useUIStore.getState().addToast({
          type: "warning",
          title: "视频已生成，保存到本地失败",
          description: "已使用远程地址播放，后台将自动重试保存",
          duration: 5000,
        });
      } else {
        useUIStore.getState().addToast({
          type: "success",
          title: "视频生成完成",
          description: `${currentModel || "默认模型"} 已完成生成`,
          duration: 3000,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errMsg = friendlyError(msg);
      setError(errMsg);
      useUIStore.getState().setCardError(card.id, errMsg);
    } finally {
      setCardProgress(card.id, null);
    }
  }, [data, card.id, generating, updateCard, currentModel, currentSize, setCardProgress, frames, imageMode, refSlots]);

  const isLocked = !!data._locked;

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      {isLocked ? (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2">
          <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">{data._label || "模板视频节点"}</p>
            {data._description && (
              <p className="text-[11px] text-muted-foreground">{data._description}</p>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="shrink-0 rounded-lg border border-dashed border-primary/25 bg-primary/[0.03] p-2">
              <div className="mb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <ImageIcon className="h-3 w-3" />
                  {imageMode === "text" && "纯文本"}
                  {imageMode === "firstFrame" && "首帧 · 1 张图"}
                  {imageMode === "firstLastFrame" && "首尾帧 · 2 张图"}
                  {imageMode === "reference" && "多模态参考"}
                </div>
                <div className="flex rounded-md border border-border bg-muted/50 p-0.5 text-[10px]">
                  {(["text", "firstFrame", "firstLastFrame", "reference"] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => handleImageModeChange(mode)}
                      disabled={generating}
                      className={cn(
                        "rounded px-1.5 py-0.5 transition-colors",
                        imageMode === mode
                          ? "bg-background font-medium text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {{ text: "文生", firstFrame: "首帧", firstLastFrame: "首尾帧", reference: "参考" }[mode]}
                    </button>
                  ))}
                </div>
              </div>

              {imageMode === "text" && (
                <p className="py-2 text-center text-[10px] text-muted-foreground/60">纯文本生视频，无需图片/视频/音频素材</p>
              )}

              {imageMode === "firstFrame" && (
                <div className="flex gap-2">
                  {frames.slice(0, 1).map((frame, idx) => (
                    <div key={frame.sourceCardId || idx} className="relative">
                      <img
                        src={getDisplayUrl(frame.url)}
                        alt="首帧"
                        className="h-16 w-auto rounded border border-border object-cover"
                      />
                      <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 py-px text-[9px] text-white">首帧</span>
                      <button
                        onClick={() => removeFrame(idx)}
                        disabled={generating}
                        className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-white shadow-sm transition-opacity hover:opacity-80 disabled:opacity-40"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  ))}
                  {frames.length === 0 && (
                    <p className="py-2 text-[10px] text-muted-foreground/60">连线一张图片卡片作为首帧</p>
                  )}
                </div>
              )}

              {imageMode === "firstLastFrame" && (
                <div className="flex gap-2">
                  {frames.map((frame, idx) => (
                    <div key={frame.sourceCardId || idx} className="relative">
                      <img
                        src={getDisplayUrl(frame.url)}
                        alt={idx === 0 ? "首帧" : "尾帧"}
                        className="h-16 w-auto rounded border border-border object-cover"
                      />
                      <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 py-px text-[9px] text-white">
                        {idx === 0 ? "首帧" : "尾帧"}
                      </span>
                      <button
                        onClick={() => removeFrame(idx)}
                        disabled={generating}
                        className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-white shadow-sm transition-opacity hover:opacity-80 disabled:opacity-40"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  ))}
                  {frames.length < 2 && (
                    <p className="py-2 text-[10px] text-muted-foreground/60">
                      {frames.length === 0 ? "连线图片卡片作为首帧和尾帧" : "再连线一张图片作为尾帧"}
                    </p>
                  )}
                </div>
              )}

              {imageMode === "reference" && (
                <div className="flex flex-wrap gap-2">
                  {refSlots.map((slot, idx) => {
                    const entry = data.refImages?.[slot.key];
                    const occupiedCount = refSlots.filter((s) => data.refImages?.[s.key]).length;
                    if (!entry && idx > occupiedCount) return null;
                    return (
                      <RefImageSlot
                        key={slot.key}
                        label={slot.label}
                        description={slot.description}
                        entry={entry}
                        onImage={(e) => setRefImage(slot.key, e)}
                        onClear={() => clearRefImage(slot.key)}
                        onRefClick={entry ? () => {
                          const opt = imageOptions.find((o) => o.id === `slot:${slot.key}`);
                          if (opt) promptRef.current?.insertRef(opt);
                        } : undefined}
                        disabled={generating}
                        targetCardId={card.id}
                        slotKey={slot.key}
                        index={entry ? idx : undefined}
                      />
                    );
                  })}
                </div>
              )}
            </div>

          {imageMode === "reference" && data.refAudios && data.refAudios.length > 0 && (
            <div className="shrink-0 rounded-lg border border-dashed border-primary/25 bg-primary/[0.03] p-2">
              <div className="mb-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                <Music className="h-3 w-3" />
                参考音频 · {data.refAudios.length} / {MAX_AUDIO_SLOTS}
              </div>
              <div className="flex flex-wrap gap-2">
                {data.refAudios.map((entry, idx) => (
                  <div
                    key={`audio-${idx}`}
                    className="relative aspect-square w-[96px] shrink-0 cursor-pointer"
                    onClick={() => {
                      const opt = imageOptions.find((o) => o.id === `audio:${idx}`);
                      if (opt) promptRef.current?.insertRef(opt);
                    }}
                    title="点击插入引用到提示词"
                  >
                    <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 overflow-hidden rounded-lg border border-input bg-muted/30 transition-colors hover:border-primary/60 hover:shadow-sm">
                      <Music className="h-6 w-6 text-muted-foreground" />
                      <span className="max-w-[80px] truncate text-[9px] text-muted-foreground">{entry.filename}</span>
                      {entry.duration != null && (
                        <span className="text-[9px] tabular-nums text-muted-foreground/60">{formatDuration(entry.duration)}</span>
                      )}
                    </div>
                    <span className="absolute left-0 top-0 z-10 flex h-5 w-5 -translate-x-1/4 -translate-y-1/4 items-center justify-center rounded-full bg-black/70 text-[10px] font-bold text-white shadow-sm">
                      {idx + 1}
                    </span>
                    {!generating && (
                      <button
                        onClick={(e) => { e.stopPropagation(); disconnectAudio(idx); }}
                        className="absolute right-1 top-1 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80"
                        title="断开音频连线"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {imageMode === "reference" && data.refVideos && data.refVideos.length > 0 && (
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
                      {entry.sourceCardId ? getCardTitle(entry.sourceCardId) : `视频${idx + 1}`}
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

          {hasUpstream && (
            <div className="shrink-0 rounded-lg border border-dashed border-primary/25 bg-primary/[0.03] p-2">
              <div className="mb-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                <ArrowDownLeft className="h-3 w-3" />
                上游文字 · 自动拼接到提示词前
              </div>
              <div className="flex flex-wrap gap-1.5">
                {upstreamEntries.map(([cardId, text]) => (
                  <span
                    key={cardId}
                    title={text}
                    className="inline-flex max-w-[180px] items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs"
                  >
                    <span className="truncate">{getCardTitle(cardId)}: {text}</span>
                    <button
                      onClick={() => removeUpstreamEntry(cardId)}
                      disabled={generating}
                      className="shrink-0 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          <PromptTextarea
            ref={promptRef}
            value={data.content ?? ""}
            inlineRefs={data.inlineRefs ?? []}
            imageOptions={imageOptions}
            onChange={onPromptChange}
            placeholder={hasUpstream ? "追加你的提示词，按 @ 引用素材…" : "描述你想生成的视频，按 @ 引用素材…"}
            disabled={generating}
          />
        </>
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
          capability="VIDEO"
          value={currentModel}
          providerId={data.provider}
          onChange={handleModelChange}
        />
        {!isLocked && (
          <SizeCombo
            value={currentSize}
            onChange={handleSizeChange}
            disabled={generating}
          />
        )}
        <div className="flex-1" />
        <button
          onClick={() => {
            if (!canGenerate && !generating) {
              useUIStore.getState().addToast({
                type: "info",
                title: "请先输入提示词",
                description: "在上方输入框中描述你想生成的视频",
                duration: 3000,
              });
              return;
            }
            void handleGenerate();
          }}
          disabled={generating}
          className={cn(
            "flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors",
            "bg-primary text-primary-foreground hover:bg-primary/90",
            generating && "cursor-not-allowed opacity-40",
            !generating && !canGenerate && "opacity-60",
          )}
        >
          {generating ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              生成中
            </>
          ) : data.videoUrl ? (
            <>
              <RefreshCw className="h-3.5 w-3.5" />
              重新生成
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5" />
              生成
            </>
          )}
        </button>
      </div>
    </div>
  );
}
