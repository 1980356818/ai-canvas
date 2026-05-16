import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { Sparkles, Loader2, RefreshCw, ArrowDownLeft, Lock, X, AlertCircle, Music, Video, Volume2, VolumeX } from "lucide-react";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard } from "@/types";
import { useUIStore } from "@/stores/uiStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { autoSave } from "@/lib/autoSave";
import { hasApiKey } from "@/platform";
import { modelService } from "@/services/models";
import { scheduleBackgroundSave, getBase64ForApi, getDisplayUrl } from "@/lib/media";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { useImageRefSources } from "@/hooks/useImageRefSources";
import { type InlineImageRef, toDisplayText } from "@/lib/promptSerializer";
import { getRefSlotsForVideoModel, compactRefImages, type RefImageEntry } from "@/config/model-ref-images";
import { disconnectCardPairAndCleanup } from "@/lib/referenceConsistency";
import ModelSelector from "./ModelSelector";
import RefImageSlot from "./RefImageSlot";
import SizeCombo from "./SizeCombo";
import PromptTextarea, { type PromptTextareaHandle } from "./PromptTextarea";
import {
  normalizeVideoSize,
  IMAGE_SIZE_OPTIONS,
  VIDEO_SIZE_OPTIONS,
  VEO_REF_RATIOS,
  sizeFromRatio,
  getAllowedVideoSizesForModel,
  getDefaultVideoSizeForModel,
} from "@/shared/constants";
import {
  isSeedanceModel,
  isVeoModel,
  isGrokVideoModel,
  resolveVeoVariantForMode,
  normalizeVeoModelToCanonical,
  inferVeoTierFromLegacy,
  VEO_NON_REF_TIERS,
  VEO_REF_TIERS,
  SEEDANCE_TIERS,
  GROK_DURATION_TIERS,
  resolveSeedanceVariantForTier,
  resolveGrokVariant,
  inferSeedanceTierFromLegacy,
  inferGrokTierFromLegacy,
  type VeoQualityTier,
  type SeedanceQualityTier,
  type GrokDurationTier,
} from "@/providers/shared/video";

interface VideoFrameRef {
  url: string;
  sourceCardId: string;
}

const MAX_AUDIO_SLOTS = 3;

// Seedance 4-15s (上游接受任意整秒)
const SEEDANCE_DURATION_OPTIONS = Array.from({ length: 12 }, (_, i) => ({
  value: String(i + 4),
  label: `${i + 4}s`,
}));
// Veo 3.1 frame 模式自由 4/6/8;参考 (image-asset) 模式锁 8s,UI 在 ref 模式下禁用此控件
const VEO_DURATION_OPTIONS = [
  { value: "4", label: "4s" },
  { value: "6", label: "6s" },
  { value: "8", label: "8s" },
];

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

// 模式只剩 2 个 — 首尾帧(用图当帧)/ 参考(用图当风格素材)。
// "文生" 不再是显式按钮:任何模式下不传图就是文生,handleGenerate 自动适配。
// 上游 dbgoc/Dale 的 frame pipeline 同一个 (role=firstFrame / lastFrame),
// 1 张图自动当首帧,2 张图当首+尾帧。
type VideoImageMode = "firstLastFrame" | "reference";

function resolveImageMode(data: { imageMode?: string; refFrames?: unknown[] }): VideoImageMode {
  const raw = data.imageMode;
  if (raw === "firstLastFrame" || raw === "reference") return raw;
  // 历史卡片兼容: firstFrame / frame 归并到 firstLastFrame;text 也归到 firstLastFrame
  // (空状态下首尾帧 = 文生,无差别)。
  return "firstLastFrame";
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
  /** @deprecated — 旧字段,迁移到 veoTier 后仅用于旧卡片兼容推断。 */
  resolution?: string;
  /** @deprecated — 旧字段,迁移到 veoTier。 */
  veoFast?: boolean;
  veoTier?: VeoQualityTier;
  /** Seedance 2.0 画质档:fast / standard。空值兼容老卡片(默认 standard)。 */
  seedanceTier?: SeedanceQualityTier;
  /** Grok Video 时长档:12s / 16s / 20s。 */
  grokTier?: GrokDurationTier;
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
  const updateCardData = useCardStore((s) => s.updateCardData);
  const setCardProgress = useUIStore((s) => s.setCardProgress);
  const generating = useUIStore((s) => s.generatingCards.has(card.id));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const promptRef = useRef<PromptTextareaHandle>(null);
  const [currentModel, setCurrentModel] = useState("");
  const [currentSize, setCurrentSize] = useState(() => normalizeVideoSize((card.data as VideoData).size));
  const [currentTier, setCurrentTier] = useState<VeoQualityTier>(() => (card.data as VideoData).veoTier ?? "fast-720p");
  const [currentSeedanceTier, setCurrentSeedanceTier] = useState<SeedanceQualityTier>(
    () => (card.data as VideoData).seedanceTier ?? "standard",
  );
  const [currentGrokTier, setCurrentGrokTier] = useState<GrokDurationTier>(
    () => (card.data as VideoData).grokTier ?? "12s",
  );
  const [currentDuration, setCurrentDuration] = useState(() => (card.data as VideoData).duration ?? 5);
  const [currentAudio, setCurrentAudio] = useState(() => (card.data as VideoData).generateAudio ?? true);
  const [error, setError] = useState<string | null>(null);
  const data = card.data as VideoData;
  const isSeedance = isSeedanceModel(currentModel);
  const isVeo = isVeoModel(currentModel);
  const isGrok = isGrokVideoModel(currentModel);
  const allowedVideoSizes = useMemo(() => getAllowedVideoSizesForModel(currentModel), [currentModel]);
  const availableModes: VideoImageMode[] = (isSeedance || isVeo || isGrok)
    ? ["firstLastFrame", "reference"]
    : ["firstLastFrame"];
  const imageMode: VideoImageMode = resolveImageMode(data);
  // Veo 参考模式 (image-asset): dbgoc 上游硬约束 16:9 + 8s,UI 强制锁
  const isVeoRefMode = isVeo && imageMode === "reference";
  const veoTierOptions = isVeoRefMode ? VEO_REF_TIERS : VEO_NON_REF_TIERS;
  const effectiveTier: VeoQualityTier = isVeoRefMode
    ? (currentTier === "ref-720p" || currentTier === "ref-1080p" ? currentTier : "ref-1080p")
    : (currentTier === "fast-720p" || currentTier === "standard-1080p" || currentTier === "pro-1080p" ? currentTier : "fast-720p");
  const effectiveAllowedSizes = useMemo(
    () => (isVeoRefMode ? [...VEO_REF_RATIOS] : allowedVideoSizes),
    [isVeoRefMode, allowedVideoSizes],
  );
  const effectiveDurationOptions = isVeo ? VEO_DURATION_OPTIONS : SEEDANCE_DURATION_OPTIONS;
  // Grok 时长已编码在 tier(SKU) 里,不需要独立 duration 控件

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
    // 旧卡片可能存了 veo3.1-fast / -4k / -pro-4k / -ref / -ref-hd 等 SKU + 旧 resolution/veoFast。
    // 全部收敛成: model=canonical "veo3.1" + veoTier (画质档单维度)。
    const migrateVeoFields = (modelId: string): { model?: string; veoTier?: VeoQualityTier } => {
      const patch: { model?: string; veoTier?: VeoQualityTier } = {};
      const canonical = normalizeVeoModelToCanonical(modelId);
      if (canonical && canonical !== modelId) {
        patch.model = canonical;
      }
      if (isVeoModel(modelId) && !data.veoTier) {
        patch.veoTier = inferVeoTierFromLegacy(modelId, data.resolution, data.veoFast);
      }
      return patch;
    };

    const migrateSeedanceFields = (modelId: string): { seedanceTier?: SeedanceQualityTier } => {
      if (!isSeedanceModel(modelId) || data.seedanceTier) return {};
      return { seedanceTier: inferSeedanceTierFromLegacy(modelId) };
    };

    const migrateGrokFields = (modelId: string): { model?: string; grokTier?: GrokDurationTier } => {
      if (!isGrokVideoModel(modelId)) return {};
      const patch: { model?: string; grokTier?: GrokDurationTier } = {};
      if (modelId !== "grok-video") patch.model = "grok-video";
      if (!data.grokTier) patch.grokTier = inferGrokTierFromLegacy(modelId);
      return patch;
    };

    const applyAndSet = (modelId: string, providerId?: string) => {
      const patch: Record<string, unknown> = {
        ...migrateVeoFields(modelId),
        ...migrateSeedanceFields(modelId),
        ...migrateGrokFields(modelId),
      };
      const nextModel = (patch.model as string) ?? modelId;
      if (providerId !== undefined) patch.provider = providerId;
      setCurrentModel(nextModel);
      if (Object.keys(patch).length > 0) {
        updateCard(card.id, { data: { ...data, ...patch } });
        if (patch.veoTier) setCurrentTier(patch.veoTier as VeoQualityTier);
        if (patch.seedanceTier) setCurrentSeedanceTier(patch.seedanceTier as SeedanceQualityTier);
        if (patch.grokTier) setCurrentGrokTier(patch.grokTier as GrokDurationTier);
      }
    };

    if (data.model && data.provider) {
      applyAndSet(data.model);
    } else if (data.model) {
      const p = modelService.tryResolveProvider(data.model);
      applyAndSet(data.model, p?.descriptor.id);
    } else {
      const saved = useSettingsStore.getState().getLastModel("video");
      if (saved) {
        applyAndSet(saved.modelId, saved.providerId);
      } else {
        modelService.getDefaultVideoModel().then(({ modelId, providerId }) => {
          applyAndSet(modelId, providerId);
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
        // The lifecycle hook removes refImages[slotKey] from the store
        // synchronously as soon as the connection is gone.
        disconnectCardPairAndCleanup(entry.sourceCardId, card.id, { markDirty: false });
      }
      const latest = useCardStore.getState().getCard(card.id)?.data as VideoData | undefined;
      const refImages = { ...(latest?.refImages ?? {}) };
      delete refImages[slotKey];
      const compacted = compactRefImages(refImages, refSlots);
      updateCardData(card.id, {
        refImages: Object.keys(compacted).length > 0 ? compacted : undefined,
      });
      autoSave.markDirty(card.id);
    },
    [card.id, data.refImages, refSlots, updateCardData],
  );

  const disconnectCards = useCallback(
    (sourceCardIds: string[]) => {
      if (sourceCardIds.length === 0) return;
      for (const sid of sourceCardIds) {
        if (!sid) continue;
        disconnectCardPairAndCleanup(sid, card.id, { markDirty: false });
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
      const patch: Record<string, unknown> = { imageMode: newMode };

      if (newMode === "firstLastFrame") {
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
        patch.refFrames = keptFrames.length > 0 ? keptFrames : undefined;
        patch.refImages = undefined;
        patch.refAudios = undefined;
        patch.refVideos = undefined;
      } else {
        const refImages: Record<string, RefImageEntry> = {};
        (frames ?? []).forEach((f, i) => {
          refImages[`refImage${i}`] = { url: f.url, sourceCardId: f.sourceCardId, sourceType: "card" };
        });
        patch.refImages = Object.keys(refImages).length > 0 ? refImages : undefined;
        patch.refFrames = undefined;
      }

      updateCardData(card.id, patch);
      autoSave.markDirty(card.id);
    },
    [imageMode, data.refImages, frames, currentModel, card.id, updateCardData, disconnectCards, collectAllSourceCardIds],
  );

  const disconnectAudio = useCallback(
    (index: number) => {
      const entry = (data.refAudios as AudioRefWithSource[] | undefined)?.[index];
      if (entry?.sourceCardId) {
        disconnectCardPairAndCleanup(entry.sourceCardId, card.id);
      }
    },
    [data.refAudios, card.id],
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

  const handleModelChange = useCallback(
    (modelId: string, providerId: string) => {
      setCurrentModel(modelId);
      const newData: Record<string, unknown> = { ...data, model: modelId, provider: providerId };
      const newIsSeedance = isSeedanceModel(modelId);
      const newIsVeo = isVeoModel(modelId);

      // Dale Seedance 上游硬约束: 不支持参考视频 (2026-05-16 实测)。
      if (newIsSeedance && Array.isArray(newData.refVideos) && (newData.refVideos as unknown[]).length > 0) {
        newData.refVideos = undefined;
      }
      // dbgoc Veo 上游: 不支持参考音频/参考视频。
      // Grok (PearNo) 同理: 只支持参考图。
      if (newIsVeo || isGrokVideoModel(modelId)) {
        newData.refAudios = undefined;
        newData.refVideos = undefined;
      }
      // Veo 参考模式 (image-asset) 最多 3 张参考图,溢出的 slot 截断。
      if (newIsVeo && imageMode === "reference" && data.refImages) {
        const oldSlots = getRefSlotsForVideoModel(currentModel, "reference");
        const entries = oldSlots
          .map((s) => data.refImages?.[s.key])
          .filter((e): e is RefImageEntry => !!e)
          .slice(0, 3);
        const refImages: Record<string, RefImageEntry> = {};
        entries.forEach((e, i) => { refImages[`refImage${i}`] = e; });
        newData.refImages = Object.keys(refImages).length > 0 ? refImages : undefined;
      }

      // 切换模型时, 把比例/分辨率收敛到新模型支持的集合, 避免发送不支持的值。
      const allowedSizes = getAllowedVideoSizesForModel(modelId);
      if (allowedSizes && !allowedSizes.includes(currentSize)) {
        const fallback = getDefaultVideoSizeForModel(modelId);
        setCurrentSize(fallback);
        newData.size = fallback;
        const opt = IMAGE_SIZE_OPTIONS.find((o) => o.value === fallback);
        if (opt) Object.assign(newData, sizeFromRatio(opt.ratio));
      }
      // Veo 默认时长 8s,与 dbgoc 上游 default_duration 对齐。
      if (newIsVeo) {
        const allowed = VEO_DURATION_OPTIONS.map((o) => Number(o.value));
        if (!allowed.includes(currentDuration)) {
          setCurrentDuration(8);
          newData.duration = 8;
        }
      }

      updateCard(card.id, { data: newData });
      autoSave.markDirty(card.id);
      useSettingsStore.getState().setLastModel("video", modelId, providerId);
    },
    [card.id, data, imageMode, currentModel, updateCard, currentSize, currentDuration],
  );

  const handleSizeChange = useCallback(
    (size: string) => {
      setCurrentSize(size);
      const updates: Parameters<typeof updateCard>[1] = { data: { ...data, size } };
      if (!data.videoUrl) {
        const opt = IMAGE_SIZE_OPTIONS.find((o) => o.value === size);
        if (opt) Object.assign(updates, sizeFromRatio(opt.ratio));
      }
      updateCard(card.id, updates);
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );

  const handleTierChange = useCallback(
    (tier: VeoQualityTier) => {
      setCurrentTier(tier);
      updateCard(card.id, { data: { ...data, veoTier: tier } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );

  const handleSeedanceTierChange = useCallback(
    (tier: SeedanceQualityTier) => {
      setCurrentSeedanceTier(tier);
      updateCard(card.id, { data: { ...data, seedanceTier: tier } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );

  const handleGrokTierChange = useCallback(
    (tier: GrokDurationTier) => {
      setCurrentGrokTier(tier);
      updateCard(card.id, { data: { ...data, grokTier: tier } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );

  const handleDurationChange = useCallback(
    (val: string) => {
      const dur = Number(val);
      setCurrentDuration(dur);
      updateCard(card.id, { data: { ...data, duration: dur } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );

  const handleAudioToggle = useCallback(() => {
    const next = !currentAudio;
    setCurrentAudio(next);
    updateCard(card.id, { data: { ...data, generateAudio: next } });
    autoSave.markDirty(card.id);
  }, [card.id, data, currentAudio, updateCard]);


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
      disconnectCardPairAndCleanup(sourceCardId, card.id);
    },
    [card.id],
  );

  const removeFrame = useCallback(
    (index: number) => {
      const frame = frames[index];
      if (!frame) return;

      if (frame.sourceCardId) {
        disconnectCardPairAndCleanup(frame.sourceCardId, card.id, { markDirty: false });
      }

      const latest = useCardStore.getState().getCard(card.id)?.data as VideoData | undefined;
      const liveFrames = (latest?.refFrames ?? []) as VideoFrameRef[];
      const newFrames = liveFrames.filter((f, i) =>
        frame.sourceCardId
          ? f.sourceCardId !== frame.sourceCardId
          : i !== index,
      );
      updateCardData(card.id, {
        refFrames: newFrames.length > 0 ? newFrames : undefined,
        upstreamImageUrl: undefined,
      });
      autoSave.markDirty(card.id);
    },
    [card.id, frames, updateCardData],
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

      // 首尾帧模式: 1 张 = 首帧, 2 张 = 首+尾帧。frame pipeline 自动适配。
      if (imageMode === "firstLastFrame") {
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
        // Seedance/Grok 上游硬约束: 拒绝 video reference.
        if ((isSeedanceModel(currentModel) || isGrokVideoModel(currentModel)) && data.refVideos?.length) {
          useUIStore.getState().addToast({
            type: "warning",
            title: "该模型不支持参考视频",
            description: "请改用参考图，或切换到其他模型",
            duration: 5000,
          });
          setCardProgress(card.id, null);
          return;
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
          referenceImages.length === 0
        ) {
          useUIStore.getState().addToast({
            type: "warning",
            title: "参考音频不能单独使用",
            description: "Seedance 要求参考音频必须搭配参考图一起使用，请先添加图片素材",
            duration: 5000,
          });
          setCardProgress(card.id, null);
          return;
        }
        // Grok 不支持参考音频,如果有的话直接清空(不打断生成流程)
        if (isGrokVideoModel(currentModel)) {
          referenceAudios.length = 0;
        }
      }

      // 把卡片本身的 projectId 作为本次任务的归属，整个异步链都用这个快照。
      const ownerProjectId = card.projectId;

      // Veo: canvas 只存 canonical "veo3.1",提交前按 (mode, tier) 解析真实 SKU。
      // Seedance: canvas 也只存 canonical "seedance",按 tier 解析成 "seedance" / "seedance-fast"。
      // Grok: canvas 只存 "grok-video",按时长档解析成 "grok-video-12s" / -16s / -20s。
      const effectiveModel = isVeo
        ? resolveVeoVariantForMode(imageMode, effectiveTier)
        : isSeedance
          ? resolveSeedanceVariantForTier(currentSeedanceTier)
          : isGrok
            ? resolveGrokVariant(currentGrokTier)
            : currentModel;
      // Veo 参考模式 (image-asset) 上游强制 8s,前端就直接传 8 避免被 resolver 默默纠正。
      // Grok 时长编码在 model SKU 里,不传 duration。
      const effectiveDuration = isVeo
        ? (isVeoRefMode ? 8 : currentDuration)
        : isSeedance
          ? currentDuration
          : undefined;

      const result = await provider.generateVideo({
        prompt,
        model: effectiveModel || undefined,
        size: currentSize,
        referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
        referenceAudios: referenceAudios.length > 0 ? referenceAudios : undefined,
        referenceVideos: referenceVideos.length > 0 ? referenceVideos : undefined,
        duration: effectiveDuration,
        // Veo/Grok: resolution 已编码在 model id 中,不再单独发送。
        // Seedance: UI 改造后画质走 tier,实际分辨率统一 720p (2.0 系列上限)。
        resolution: isSeedance ? "720p" : undefined,
        generateAudio: (isSeedance || isVeo || isGrok) ? currentAudio : undefined,
        projectId: ownerProjectId,
        onProgress: (p) => {
          setCardProgress(card.id, { percent: p.percent, label: p.label });
        },
      });

      const sizeOpt = IMAGE_SIZE_OPTIONS.find((o) => o.value === currentSize);
      const cardSize = sizeOpt ? sizeFromRatio(sizeOpt.ratio) : {};
      updateCard(card.id, { data: { ...data, videoUrl: result.url }, ...cardSize });
      autoSave.markDirty(card.id);

      const isRemote = result.url.startsWith("http://") || result.url.startsWith("https://");
      if (isRemote) {
        scheduleBackgroundSave(card.id, result.url, "videoUrl", ownerProjectId);
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
  }, [data, card.id, generating, updateCard, currentModel, currentSize, effectiveTier, currentSeedanceTier, currentGrokTier, currentDuration, currentAudio, setCardProgress, frames, imageMode, refSlots, isVeo, isVeoRefMode, isSeedance, isGrok]);

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
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            {availableModes.map((mode) => (
              <button
                key={mode}
                onClick={() => handleImageModeChange(mode)}
                disabled={generating}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-all",
                  imageMode === mode
                    ? "border-primary bg-primary/10 font-medium text-primary shadow-sm"
                    : "border-border bg-muted/40 text-muted-foreground hover:border-primary/40 hover:bg-primary/5 hover:text-foreground",
                  generating && "opacity-50",
                )}
              >
                {{ firstLastFrame: "首尾帧", reference: "参考" }[mode]}
              </button>
            ))}
          </div>

          {imageMode === "firstLastFrame" && frames.length > 0 && (
            <div className="flex shrink-0 flex-wrap gap-2">
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

          {imageMode === "reference" && refSlots.some((s) => data.refImages?.[s.key]) && (
            <div className="flex shrink-0 flex-wrap gap-2">
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

          {imageMode === "reference" && !isGrok && data.refAudios && data.refAudios.length > 0 && (
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

          {/* Seedance/Grok 上游不接受 video reference, 直接隐藏 UI */}
          {imageMode === "reference" && !isSeedance && !isGrok && data.refVideos && data.refVideos.length > 0 && (
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
            sizeOptions={VIDEO_SIZE_OPTIONS}
            allowedSizes={effectiveAllowedSizes}
            resolution={
              isVeo
                ? effectiveTier
                : isSeedance
                  ? currentSeedanceTier
                  : isGrok
                    ? currentGrokTier
                    : undefined
            }
            onResolutionChange={
              isVeo
                ? (tier: string) => handleTierChange(tier as VeoQualityTier)
                : isSeedance
                  ? (tier: string) => handleSeedanceTierChange(tier as SeedanceQualityTier)
                  : isGrok
                    ? (tier: string) => handleGrokTierChange(tier as GrokDurationTier)
                    : undefined
            }
            resolutionOptions={
              isVeo
                ? veoTierOptions.map((t) => ({ value: t.value, label: t.label }))
                : isSeedance
                  ? SEEDANCE_TIERS.map((t) => ({ value: t.value, label: t.label }))
                  : isGrok
                    ? GROK_DURATION_TIERS.map((t) => ({ value: t.value, label: t.label }))
                    : undefined
            }
            duration={(isSeedance || isVeo) ? (isVeoRefMode ? 8 : currentDuration) : undefined}
            onDurationChange={(isSeedance || isVeo) ? (n) => handleDurationChange(String(n)) : undefined}
            durationOptions={(isSeedance || isVeo) ? effectiveDurationOptions : undefined}
            durationDisabled={isVeoRefMode}
            disabled={generating}
          />
        )}
        {(isSeedance || isVeo || isGrok) && !isLocked && (
          <button
            type="button"
            onClick={handleAudioToggle}
            disabled={generating}
            className={cn(
              "flex items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors",
              currentAudio
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
              generating && "cursor-not-allowed opacity-40",
            )}
          >
            {currentAudio ? <Volume2 className="h-3 w-3" /> : <VolumeX className="h-3 w-3" />}
            {currentAudio ? "有声" : "无声"}
          </button>
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
