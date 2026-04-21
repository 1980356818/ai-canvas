import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { Sparkles, Loader2, RefreshCw, ArrowDownLeft, Lock, X, AlertCircle, ImageIcon, Music, Upload, Play, Square } from "lucide-react";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard } from "@/types";
import { useUIStore } from "@/stores/uiStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { autoSave } from "@/lib/autoSave";
import { hasApiKey } from "@/platform";
import { modelService } from "@/services/models";
import { scheduleBackgroundSave, getBase64ForApi, getDisplayUrl, persistImage } from "@/lib/media";
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
import PromptTextarea from "./PromptTextarea";
import { normalizeImageSize } from "@/shared/constants";

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

function getAudioDuration(file: File): Promise<number | undefined> {
  return new Promise((resolve) => {
    const audio = new Audio();
    const blobUrl = URL.createObjectURL(file);
    const cleanup = () => { audio.onloadedmetadata = null; audio.onerror = null; URL.revokeObjectURL(blobUrl); };
    const timer = setTimeout(() => { cleanup(); resolve(undefined); }, 3000);
    audio.onloadedmetadata = () => {
      clearTimeout(timer);
      const dur = audio.duration;
      cleanup();
      resolve(Number.isFinite(dur) ? Math.round(dur * 10) / 10 : undefined);
    };
    audio.onerror = () => { clearTimeout(timer); cleanup(); resolve(undefined); };
    audio.src = blobUrl;
  });
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type VideoImageMode = "frame" | "reference";

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
  const [currentModel, setCurrentModel] = useState("");
  const [currentSize, setCurrentSize] = useState(() => normalizeImageSize((card.data as VideoData).size));
  const [error, setError] = useState<string | null>(null);
  const data = card.data as VideoData;
  const imageMode: VideoImageMode = data.imageMode ?? "frame";

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

  const imageOptions = useImageRefSources(card.id, refSlots, data.refImages, data.refAudios);

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

  const handleImageModeChange = useCallback(
    (newMode: VideoImageMode) => {
      if (imageMode === newMode) return;
      const newData: Record<string, unknown> = { ...data, imageMode: newMode };

      if (newMode === "reference") {
        const refImages: Record<string, RefImageEntry> = {};
        (frames ?? []).forEach((f, i) => {
          refImages[`refImage${i}`] = { url: f.url, sourceCardId: f.sourceCardId, sourceType: "card" };
        });
        newData.refImages = Object.keys(refImages).length > 0 ? refImages : undefined;
        newData.refFrames = undefined;
      } else {
        const slots = getRefSlotsForVideoModel(currentModel, "reference");
        const entries = slots
          .map((s) => data.refImages?.[s.key])
          .filter((e): e is RefImageEntry => !!e);

        const kept = entries.slice(0, 2);
        const dropped = entries.slice(2);
        const newFrames = kept.map((e) => ({
          url: e.url,
          sourceCardId: e.sourceCardId ?? "",
        }));
        newData.refFrames = newFrames.length > 0 ? newFrames : undefined;
        newData.refImages = undefined;

        if (dropped.length > 0) {
          const { connections, removeConnection } = useConnectionStore.getState();
          for (const entry of dropped) {
            if (!entry.sourceCardId) continue;
            for (const [id, c] of connections) {
              if (c.sourceCardId === entry.sourceCardId && c.targetCardId === card.id) {
                removeConnection(id);
                break;
              }
            }
          }
        }
      }

      updateCard(card.id, { data: newData });
      autoSave.markDirty(card.id);
    },
    [imageMode, data, frames, currentModel, card.id, updateCard],
  );

  const audioInputRef = useRef<HTMLInputElement>(null);
  const [playingAudioIdx, setPlayingAudioIdx] = useState<number | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  const addAudioFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("audio/") && !/\.(wav|mp3)$/i.test(file.name)) return;
      const audios = data.refAudios ?? [];
      if (audios.length >= MAX_AUDIO_SLOTS) {
        useUIStore.getState().addToast({ type: "warning", title: `最多添加 ${MAX_AUDIO_SLOTS} 段参考音频`, duration: 3000 });
        return;
      }
      if (file.size > 15 * 1024 * 1024) {
        useUIStore.getState().addToast({ type: "warning", title: "单段音频不超过 15 MB", duration: 3000 });
        return;
      }
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
      const pid = useProjectStore.getState().currentProjectId ?? undefined;
      const saved = await persistImage(dataUrl, undefined, pid);
      const duration = await getAudioDuration(file);

      const newAudios = [...audios, { url: saved.localPath, filename: file.name, duration }];
      updateCard(card.id, { data: { ...data, refAudios: newAudios } });
      autoSave.markDirty(card.id);
    },
    [data, card.id, updateCard],
  );

  const removeAudio = useCallback(
    (index: number) => {
      if (playingAudioIdx === index) {
        audioElRef.current?.pause();
        setPlayingAudioIdx(null);
      }
      const newAudios = (data.refAudios ?? []).filter((_, i) => i !== index);
      updateCard(card.id, { data: { ...data, refAudios: newAudios.length > 0 ? newAudios : undefined } });
      autoSave.markDirty(card.id);
    },
    [data, card.id, updateCard, playingAudioIdx],
  );

  const togglePlayAudio = useCallback(
    (index: number) => {
      const entry = data.refAudios?.[index];
      if (!entry) return;
      if (playingAudioIdx === index) {
        audioElRef.current?.pause();
        setPlayingAudioIdx(null);
        return;
      }
      if (audioElRef.current) audioElRef.current.pause();
      const audio = new Audio(getDisplayUrl(entry.url));
      audio.onended = () => setPlayingAudioIdx(null);
      audio.play();
      audioElRef.current = audio;
      setPlayingAudioIdx(index);
    },
    [data.refAudios, playingAudioIdx],
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
      if (imageMode === "reference") {
        for (const slot of refSlots) {
          const entry = data.refImages?.[slot.key];
          if (entry) {
            const dataUrl = await getBase64ForApi(entry.url);
            referenceImages.push({ url: dataUrl, role: "referenceImage" });
          }
        }
      } else {
        for (let i = 0; i < frames.length; i++) {
          const dataUrl = await getBase64ForApi(frames[i]!.url);
          referenceImages.push({ url: dataUrl, role: i === 0 ? "firstFrame" : "lastFrame" });
        }
      }

      const referenceAudios: Array<{ url: string; role: string }> = [];
      if (data.refAudios?.length) {
        for (const entry of data.refAudios) {
          const dataUrl = await getBase64ForApi(entry.url);
          referenceAudios.push({ url: dataUrl, role: "referenceAudio" });
        }
      }

      const result = await provider.generateVideo({
        prompt,
        model: currentModel || undefined,
        size: currentSize,
        referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
        referenceAudios: referenceAudios.length > 0 ? referenceAudios : undefined,
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
          {(frames.length > 0 || imageMode === "reference" || refSlots.some((s) => data.refImages?.[s.key])) && (
            <div className="shrink-0 rounded-lg border border-dashed border-primary/25 bg-primary/[0.03] p-2">
              <div className="mb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <ImageIcon className="h-3 w-3" />
                  {imageMode === "reference" ? "参考图 · 最多 9 张" : "参考帧 · 最多 2 帧"}
                </div>
                <div className="flex rounded-md border border-border bg-muted/50 p-0.5 text-[10px]">
                  <button
                    onClick={() => handleImageModeChange("frame")}
                    disabled={generating}
                    className={cn(
                      "rounded px-2 py-0.5 transition-colors",
                      imageMode === "frame"
                        ? "bg-background font-medium text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    首尾帧
                  </button>
                  <button
                    onClick={() => handleImageModeChange("reference")}
                    disabled={generating}
                    className={cn(
                      "rounded px-2 py-0.5 transition-colors",
                      imageMode === "reference"
                        ? "bg-background font-medium text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    参考图
                  </button>
                </div>
              </div>

              {imageMode === "reference" ? (
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
                        disabled={generating}
                        targetCardId={card.id}
                        slotKey={slot.key}
                        index={entry ? idx : undefined}
                      />
                    );
                  })}
                </div>
              ) : (
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
                </div>
              )}
            </div>
          )}

          <div className="shrink-0 rounded-lg border border-dashed border-primary/25 bg-primary/[0.03] p-2">
            <div className="mb-1.5 flex items-center justify-between">
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Music className="h-3 w-3" />
                参考音频 · 最多 {MAX_AUDIO_SLOTS} 段
              </div>
              {(data.refAudios?.length ?? 0) < MAX_AUDIO_SLOTS && (
                <button
                  onClick={() => audioInputRef.current?.click()}
                  disabled={generating}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                >
                  <Upload className="h-3 w-3" />
                  添加
                </button>
              )}
            </div>
            <input
              ref={audioInputRef}
              type="file"
              accept=".wav,.mp3,audio/wav,audio/mpeg"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) addAudioFile(file);
                e.target.value = "";
              }}
            />
            {data.refAudios && data.refAudios.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                {data.refAudios.map((entry, idx) => (
                  <div
                    key={`${entry.filename}-${idx}`}
                    className="flex items-center gap-2 rounded-md bg-muted/60 px-2 py-1.5"
                  >
                    <button
                      onClick={() => togglePlayAudio(idx)}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary transition-colors hover:bg-primary/25"
                    >
                      {playingAudioIdx === idx
                        ? <Square className="h-2.5 w-2.5 fill-current" />
                        : <Play className="h-2.5 w-2.5 fill-current" />}
                    </button>
                    <span className="min-w-0 flex-1 truncate text-xs">
                      <span className="font-medium text-foreground">音频{idx + 1}</span>
                      <span className="ml-1 text-muted-foreground">{entry.filename}</span>
                    </span>
                    {entry.duration != null && (
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {formatDuration(entry.duration)}
                      </span>
                    )}
                    <button
                      onClick={() => removeAudio(idx)}
                      disabled={generating}
                      className="shrink-0 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <button
                onClick={() => audioInputRef.current?.click()}
                disabled={generating}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-input py-2 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-40"
              >
                <Upload className="h-3.5 w-3.5" />
                点击上传 .wav / .mp3
              </button>
            )}
          </div>

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
            value={data.content ?? ""}
            inlineRefs={data.inlineRefs ?? []}
            imageOptions={imageOptions}
            onChange={onPromptChange}
            placeholder={hasUpstream ? "追加你的提示词，按 @ 引用图片…" : "描述你想生成的视频，按 @ 引用图片…"}
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
          onClick={() => void handleGenerate()}
          disabled={generating || !canGenerate}
          className={cn(
            "flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors",
            "bg-primary text-primary-foreground hover:bg-primary/90",
            (generating || !canGenerate) && "cursor-not-allowed opacity-40",
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
