import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { Sparkles, Loader2, RefreshCw, ArrowDownLeft, Lock, X, AlertCircle, Music, Video, Volume2, VolumeX } from "lucide-react";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard } from "@/types";
import { useUIStore, selectCardBusy } from "@/stores/uiStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { autoSave } from "@/lib/autoSave";
import { modelService } from "@/services/models";
import { resolveDefaultModelForCardType } from "@/services/modelDefaults";
import { buildVideoRequest } from "@/services/generation/buildVideoRequest";
import { runEditorGeneration } from "@/services/generation/runEditorGeneration";
import { getDisplayUrl } from "@/lib/media";
import { scheduleCardMediaLocalization } from "@/lib/mediaLocalize";
import { cn } from "@/lib/utils";
import { useImageRefSources } from "@/hooks/useImageRefSources";
import { type InlineImageRef, toDisplayText } from "@/lib/promptSerializer";
import { getRefSlotsForVideoModel, compactRefImages, resolveVideoImageMode, type VideoImageMode, type RefImageEntry } from "@/config/model-ref-images";
import { disconnectCardPairAndCleanup } from "@/lib/referenceConsistency";
import ModelSelector from "./ModelSelector";
import RefImageSlot from "./RefImageSlot";
import SizeCombo from "./SizeCombo";
import PromptTextarea, { type PromptTextareaHandle } from "./PromptTextarea";
import {
  normalizeVideoSize,
  IMAGE_SIZE_OPTIONS,
  VIDEO_SIZE_OPTIONS,
  sizeFromRatio,
  getAllowedVideoSizesForModel,
  getDefaultVideoSizeForModel,
} from "@/shared/constants";
import {
  isSeedanceModel,
  isVeoModel,
  isGrokVideoModel,
  isSeedanceVipModel,
  isSeedanceVipAliasModel,
  isSeedanceVipEconomyModel,
  veoRefImageMaxCount,
  composeVeoTier,
  decomposeVeoTier,
  normalizeVeoModelToCanonical,
  inferVeoTierFromLegacy,
  SEEDANCE_VIP_RESOLUTION_TIERS,
  VEO_TIERS,
  VEO_QUALITY_TIERS,
  VEO_RESOLUTION_TIERS,
  SEEDANCE_TIERS,
  GROK_DURATION_TIERS,
  inferSeedanceTierFromLegacy,
  inferGrokTierFromLegacy,
  // V161 火山方舟原生 Seedance 2.0 聚合 alias `seedance-v2`
  isSeedanceV2AliasModel,
  // V188 极境 DSF/甜甜圈 Omni (Veo Omni Flash) 生成 + 视频编辑
  isOmniModel,
  SEEDANCE_V2_VERSION_TIERS,
  SEEDANCE_V2_RESOLUTION_TIERS,
  isSeedanceV2ResolutionAllowed,
  clampSeedanceV2Resolution,
  type VeoQualityTier,
  type VeoQuality,
  type VeoResolution,
  type SeedanceQualityTier,
  type SeedanceVipResolution,
  type SeedanceV2Version,
  type SeedanceV2Resolution,
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
// V145 VIP: 后端 NexusVideoAdapter.resolveSeconds 支持 5-15s, 暂只放出 15s 单选保产品节奏.
// 后续放开范围只需扩这个数组 + 在 handleModelChange 里允许更宽的默认值.
const SEEDANCE_VIP_DURATION_OPTIONS = [{ value: "15", label: "15s" }];

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

// VideoImageMode 类型和 resolveVideoImageMode 统一从 @/config/model-ref-images 导入,
// 禁止在此重复定义,避免默认值漂移。

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
  /** Seedance 2.0 VIP (Nexus, V138) 分辨率档:720p / 1080p. 仅 alias 项 `seedance-2-0` 用. */
  seedanceVipResolution?: SeedanceVipResolution;
  /** Seedance 2.0 火山原生 (V161) 画质档: standard / fast. 仅 alias 项 `seedance-v2` 用,
   *  跟 seedanceTier (老 Dale 路) 区分; resolveSeedanceV2ModelId 按 (version × hasVideos) 4 路分发. */
  seedanceV2Version?: SeedanceV2Version;
  /** Seedance 2.0 火山原生 (V161) 分辨率档: 480p/720p/1080p. 仅 alias `seedance-v2` 用; fast 不支持 1080p。 */
  seedanceV2Resolution?: SeedanceV2Resolution;
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
  const generating = useUIStore(selectCardBusy(card.id));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const promptRef = useRef<PromptTextareaHandle>(null);
  const [currentModel, setCurrentModel] = useState("");
  const [currentSize, setCurrentSize] = useState(() => normalizeVideoSize((card.data as VideoData).size));
  const [currentTier, setCurrentTier] = useState<VeoQualityTier>(() => (card.data as VideoData).veoTier ?? "fast-720p");
  const [currentSeedanceTier, setCurrentSeedanceTier] = useState<SeedanceQualityTier>(
    () => (card.data as VideoData).seedanceTier ?? "standard",
  );
  const [currentSeedanceVipResolution, setCurrentSeedanceVipResolution] = useState<SeedanceVipResolution>(
    () => (card.data as VideoData).seedanceVipResolution ?? "720p",
  );
  const [currentSeedanceV2Version, setCurrentSeedanceV2Version] = useState<SeedanceV2Version>(
    () => (card.data as VideoData).seedanceV2Version ?? "standard",
  );
  const [currentSeedanceV2Resolution, setCurrentSeedanceV2Resolution] = useState<SeedanceV2Resolution>(
    () => (card.data as VideoData).seedanceV2Resolution ?? "720p",
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
  const isSeedanceVip = isSeedanceVipModel(currentModel);
  const isVipAlias = isSeedanceVipAliasModel(currentModel);
  const isVipEconomy = isSeedanceVipEconomyModel(currentModel);
  const isSeedanceV2 = isSeedanceV2AliasModel(currentModel);
  const isOmni = isOmniModel(currentModel);
  const allowedVideoSizes = useMemo(() => getAllowedVideoSizesForModel(currentModel), [currentModel]);
  const availableModes: VideoImageMode[] = (isSeedance || isVeo || isGrok || isSeedanceVip || isSeedanceV2 || isOmni)
    ? ["firstLastFrame", "reference"]
    : ["firstLastFrame"];
  const imageMode: VideoImageMode = resolveVideoImageMode(data.imageMode);
  // Veo 6 档 tier (画质 × 分辨率) 不再因 imageMode 切换列表; 三模式 (text/i2v/ref)
  // 由后端 CatVideoAdapter 看 body 字段 (images / referenceImages) 自动分发.
  // i2v 和 ref 模式后端强制 duration=8, UI 在有图时锁 8 给用户清晰预期.
  const validVeoTier = isVeo && VEO_TIERS.some((t) => t.value === currentTier);
  const effectiveTier: VeoQualityTier = validVeoTier ? currentTier : "fast-720p";
  // 画质和分辨率独立选: UI 上 SizeCombo 的 quality 槽放 fast/std/pro,
  // resolution 槽放 720p/1080p. 两者组合 → composeVeoTier → 6 档 SKU.
  const { quality: veoQuality, resolution: veoResolution } = decomposeVeoTier(effectiveTier);
  const effectiveAllowedSizes = allowedVideoSizes;
  const effectiveDurationOptions = isVeo
    ? VEO_DURATION_OPTIONS
    : isSeedanceVip
      ? SEEDANCE_VIP_DURATION_OPTIONS
      : SEEDANCE_DURATION_OPTIONS;
  // V161 火山原生 Seedance 2.0 复用 SEEDANCE_DURATION_OPTIONS (4-15s).
  // VIP (V145): UI 只放 15s 单选, 切到 VIP 时强制 currentDuration=15.
  // Grok 时长已编码在 tier(SKU) 里, 不需要独立 duration 控件.

  const refSlots = useMemo(
    () => getRefSlotsForVideoModel(currentModel, imageMode, isVeo ? effectiveTier : undefined),
    [currentModel, imageMode, isVeo, effectiveTier],
  );

  // Veo 时长前端不锁: 用户在 4/6/8 自由选. Cat 后端 CatVideoAdapter 在 i2v / ref 模式
  // (body.images 或 body.referenceImages 非空) 会自动强制 duration=8 (L223 durationOverride),
  // 纯文生模式按用户传的 duration. 前端宽松, 让 UI 始终能选; 实际生成时长以后端响应为准.

  const upstreamEntries = useMemo(
    () => Object.entries(data.upstreamTexts || {}),
    [data.upstreamTexts],
  );
  const hasUpstream = upstreamEntries.length > 0;

  const finalPrompt = useMemo(() => buildFinalPrompt(data), [data]);
  const canGenerate = finalPrompt.length > 0;

  useEffect(() => {
    // 旧卡片可能存了 veo3.1-fast / -4k / -pro-4k / -ref / -ref-hd 等 SKU + 旧 resolution/veoFast,
    // 以及老 5 档 veoTier (standard-1080p / ref-720p / ref-1080p). 全部收敛成: model=canonical
    // "veo3.1" + veoTier (新 6 档画质 × 分辨率, ref 模式由 imageMode 表达不再编码在 tier 里).
    const migrateVeoFields = (modelId: string): { model?: string; veoTier?: VeoQualityTier; duration?: number } => {
      const patch: { model?: string; veoTier?: VeoQualityTier; duration?: number } = {};
      const canonical = normalizeVeoModelToCanonical(modelId);
      if (canonical && canonical !== modelId) {
        patch.model = canonical;
      }
      if (isVeoModel(modelId)) {
        if (!data.veoTier) {
          patch.veoTier = inferVeoTierFromLegacy(modelId, data.resolution, data.veoFast);
        } else if (!VEO_TIERS.some((t) => t.value === data.veoTier)) {
          // 老 5 档 veoTier (standard-1080p / ref-720p / ref-1080p) 收敛到新 6 档.
          // inferVeoTierFromLegacy 的 legacyResolution 分支兼容这些字符串.
          patch.veoTier = inferVeoTierFromLegacy(undefined, data.veoTier);
        }
        // Veo 时长只接受 4/6/8 (Cat 上游约束). 老卡片或 currentDuration 默认 5 时,
        // trigger 会显示"·5s"且下拉无 active 按钮, 兜底 8 让 UI 有明确选中态.
        if (data.duration == null || ![4, 6, 8].includes(data.duration)) {
          patch.duration = 8;
        }
      }
      return patch;
    };

    const migrateSeedanceFields = (modelId: string): { seedanceTier?: SeedanceQualityTier } => {
      if (!isSeedanceModel(modelId) || data.seedanceTier) return {};
      return { seedanceTier: inferSeedanceTierFromLegacy(modelId) };
    };

    // V138: VIP 不再用 quality (fast/standard) 字段, 只用 model_name + size 决定上游.
    // alias 项 `seedance-2-0` 需要 seedanceVipResolution 字段决定 720P / 1080P.
    // economy 项 `seedance-2-0-720p-no-person` 固定 720P, 不需要这个字段.
    // V145: 5 个 VIP 模型 (alias + economy) 都强制 duration=15 (UI 单选).
    const migrateSeedanceVipFields = (modelId: string): {
      seedanceVipResolution?: SeedanceVipResolution;
      duration?: number;
    } => {
      const patch: { seedanceVipResolution?: SeedanceVipResolution; duration?: number } = {};
      if (isSeedanceVipAliasModel(modelId) && !data.seedanceVipResolution) {
        patch.seedanceVipResolution = "720p";
      }
      if (isSeedanceVipModel(modelId) && data.duration !== 15) {
        patch.duration = 15;
      }
      return patch;
    };

    const migrateGrokFields = (modelId: string): { model?: string; grokTier?: GrokDurationTier } => {
      if (!isGrokVideoModel(modelId)) return {};
      const patch: { model?: string; grokTier?: GrokDurationTier } = {};
      if (modelId !== "grok-video") patch.model = "grok-video";
      if (!data.grokTier) patch.grokTier = inferGrokTierFromLegacy(modelId);
      return patch;
    };

    // omni: 默认参考模式 (r2v)。"连源视频自动转编辑" 依赖 reference 态 —— firstLastFrame
    // 模式下 dataFlow 会拒视频连线。仅在 imageMode 未设时兜底,尊重用户已选的首尾帧。
    const migrateOmniFields = (modelId: string): { imageMode?: VideoImageMode } => {
      if (!isOmniModel(modelId) || data.imageMode) return {};
      return { imageMode: "reference" };
    };

    // 卡片里残留的 size 不在新模型 allow 列表里就 fallback (handleModelChange 已处理
    // 主动切换路径, 这里专治 mount 时 model+size 不自洽的存档 — 如 21:9 卡切到 VIP)。
    const migrateSize = (modelId: string): { size?: string } => {
      const allowed = getAllowedVideoSizesForModel(modelId);
      if (!allowed) return {};
      const current = normalizeVideoSize(data.size);
      if (allowed.includes(current)) return {};
      return { size: getDefaultVideoSizeForModel(modelId) };
    };

    const applyAndSet = (modelId: string, providerId?: string) => {
      const patch: Record<string, unknown> = {
        ...migrateVeoFields(modelId),
        ...migrateSeedanceFields(modelId),
        ...migrateSeedanceVipFields(modelId),
        ...migrateGrokFields(modelId),
        ...migrateOmniFields(modelId),
        ...migrateSize(modelId),
      };
      const nextModel = (patch.model as string) ?? modelId;
      if (providerId !== undefined) patch.provider = providerId;
      setCurrentModel(nextModel);
      if (Object.keys(patch).length > 0) {
        updateCardData(card.id, patch);
        if (typeof patch.size === "string") {
          const opt = IMAGE_SIZE_OPTIONS.find((o) => o.value === patch.size);
          if (opt) updateCard(card.id, sizeFromRatio(opt.ratio));
        }
        if (patch.veoTier) setCurrentTier(patch.veoTier as VeoQualityTier);
        if (patch.seedanceTier) setCurrentSeedanceTier(patch.seedanceTier as SeedanceQualityTier);
        if (patch.seedanceVipResolution) setCurrentSeedanceVipResolution(patch.seedanceVipResolution as SeedanceVipResolution);
        if (patch.grokTier) setCurrentGrokTier(patch.grokTier as GrokDurationTier);
        if (typeof patch.size === "string") setCurrentSize(patch.size);
        if (typeof patch.duration === "number") setCurrentDuration(patch.duration);
      }
    };

    if (data.model && data.provider) {
      applyAndSet(data.model);
    } else if (data.model) {
      const p = modelService.tryResolveProvider(data.model);
      applyAndSet(data.model, p?.descriptor.id);
    } else {
      // 默认模型统一走 modelDefaults 的单一口径(见 services/modelDefaults.ts)。
      let cancelled = false;
      resolveDefaultModelForCardType(card.type).then((ref) => {
        if (cancelled || !ref) return;
        applyAndSet(ref.modelId, ref.providerId);
      });
      return () => {
        cancelled = true;
      };
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
      const latest = (useCardStore.getState().getCard(card.id)?.data ?? {}) as Record<string, unknown>;
      const refImages = { ...(latest.refImages as Record<string, RefImageEntry> | undefined), [slotKey]: entry };
      updateCardData(card.id, { refImages });
      autoSave.markDirty(card.id);
    },
    [card.id, updateCardData],
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
      const latest = (useCardStore.getState().getCard(card.id)?.data ?? {}) as VideoData;
      const dataPatch: Record<string, unknown> = { model: modelId, provider: providerId };
      const geoPatch: Record<string, unknown> = {};
      const newIsSeedance = isSeedanceModel(modelId);
      const newIsVeo = isVeoModel(modelId);

      // Dale Seedance 上游硬约束: 不支持参考视频 (2026-05-16 实测)。
      if (newIsSeedance && Array.isArray(latest.refVideos) && latest.refVideos.length > 0) {
        dataPatch.refVideos = undefined;
      }
      // dbgoc Veo 上游: 不支持参考音频/参考视频。
      // Grok (PearNo) 同理: 只支持参考图。
      if (newIsVeo || isGrokVideoModel(modelId)) {
        dataPatch.refAudios = undefined;
        dataPatch.refVideos = undefined;
      }
      // Veo 参考模式: Cat 上游硬约束 fast 1-2 张, std/pro 1-3 张. 按当前 tier 算上限截断.
      if (newIsVeo && imageMode === "reference" && latest.refImages) {
        const safeTier = VEO_TIERS.some((t) => t.value === currentTier) ? currentTier : "fast-720p";
        const maxCount = veoRefImageMaxCount(safeTier);
        const oldSlots = getRefSlotsForVideoModel(currentModel, "reference");
        const entries = oldSlots
          .map((s) => latest.refImages?.[s.key])
          .filter((e): e is RefImageEntry => !!e)
          .slice(0, maxCount);
        const refImages: Record<string, RefImageEntry> = {};
        entries.forEach((e, i) => { refImages[`refImage${i}`] = e; });
        dataPatch.refImages = Object.keys(refImages).length > 0 ? refImages : undefined;
      }

      // 切换模型时, 把比例/分辨率收敛到新模型支持的集合, 避免发送不支持的值。
      const allowedSizes = getAllowedVideoSizesForModel(modelId);
      if (allowedSizes && !allowedSizes.includes(currentSize)) {
        const fallback = getDefaultVideoSizeForModel(modelId);
        setCurrentSize(fallback);
        dataPatch.size = fallback;
        const opt = IMAGE_SIZE_OPTIONS.find((o) => o.value === fallback);
        if (opt) Object.assign(geoPatch, sizeFromRatio(opt.ratio));
      }
      // Veo 默认时长 8s,与 dbgoc 上游 default_duration 对齐。
      if (newIsVeo) {
        const allowed = VEO_DURATION_OPTIONS.map((o) => Number(o.value));
        if (!allowed.includes(currentDuration)) {
          setCurrentDuration(8);
          dataPatch.duration = 8;
        }
      }
      // V138 VIP: economy 项不支持视频参考, 切到 economy 时清空 refVideos.
      // alias 项首次进入时确保 seedanceVipResolution 有值 (默认 720P).
      // V145: 切到任意 VIP 模型时把 duration 强制 15 (UI 只放 15s 选项).
      if (isSeedanceVipEconomyModel(modelId)) {
        // Re-check latest after prior patches may have set refVideos to undefined
        if (dataPatch.refVideos === undefined) { /* already cleared above */ }
        else if (Array.isArray(latest.refVideos) && latest.refVideos.length > 0) {
          dataPatch.refVideos = undefined;
        }
      }
      if (isSeedanceVipAliasModel(modelId) && !latest.seedanceVipResolution) {
        dataPatch.seedanceVipResolution = "720p";
        setCurrentSeedanceVipResolution("720p");
      }
      if (isSeedanceVipModel(modelId) && currentDuration !== 15) {
        setCurrentDuration(15);
        dataPatch.duration = 15;
      }
      // V161 火山方舟原生 alias `seedance-v2`: 首次进入时默认 standard 画质,
      // duration 收敛到 [4,15] (老卡片可能是 grok 的 12s 之类, 直接保留亦合法).
      if (isSeedanceV2AliasModel(modelId) && !latest.seedanceV2Version) {
        dataPatch.seedanceV2Version = "standard";
        setCurrentSeedanceV2Version("standard");
      }
      if (isSeedanceV2AliasModel(modelId) && !latest.seedanceV2Resolution) {
        dataPatch.seedanceV2Resolution = "720p";
        setCurrentSeedanceV2Resolution("720p");
      }
      if (isSeedanceV2AliasModel(modelId) && (currentDuration < 4 || currentDuration > 15)) {
        setCurrentDuration(5);
        dataPatch.duration = 5;
      }

      updateCardData(card.id, dataPatch);
      if (Object.keys(geoPatch).length > 0) updateCard(card.id, geoPatch);
      autoSave.markDirty(card.id);
      useSettingsStore.getState().setLastModel("video", modelId, providerId);
    },
    [card.id, imageMode, currentModel, updateCard, updateCardData, currentSize, currentDuration],
  );

  const handleSizeChange = useCallback(
    (size: string) => {
      setCurrentSize(size);
      const latest = (useCardStore.getState().getCard(card.id)?.data ?? {}) as Record<string, unknown>;
      updateCardData(card.id, { size });
      if (!latest.videoUrl) {
        const opt = IMAGE_SIZE_OPTIONS.find((o) => o.value === size);
        if (opt) updateCard(card.id, sizeFromRatio(opt.ratio));
      }
      autoSave.markDirty(card.id);
    },
    [card.id, updateCard, updateCardData],
  );

  const handleTierChange = useCallback(
    (tier: VeoQualityTier) => {
      setCurrentTier(tier);
      updateCardData(card.id, { veoTier: tier });
      autoSave.markDirty(card.id);
    },
    [card.id, updateCardData],
  );

  const handleVeoQualityChange = useCallback(
    (q: VeoQuality) => {
      handleTierChange(composeVeoTier(q, veoResolution));
    },
    [veoResolution, handleTierChange],
  );

  const handleVeoResolutionChange = useCallback(
    (r: VeoResolution) => {
      handleTierChange(composeVeoTier(veoQuality, r));
    },
    [veoQuality, handleTierChange],
  );

  const handleSeedanceTierChange = useCallback(
    (tier: SeedanceQualityTier) => {
      setCurrentSeedanceTier(tier);
      updateCardData(card.id, { seedanceTier: tier });
      autoSave.markDirty(card.id);
    },
    [card.id, updateCardData],
  );

  const handleSeedanceVipResolutionChange = useCallback(
    (resolution: SeedanceVipResolution) => {
      setCurrentSeedanceVipResolution(resolution);
      updateCardData(card.id, { seedanceVipResolution: resolution });
      autoSave.markDirty(card.id);
    },
    [card.id, updateCardData],
  );

  const handleSeedanceV2VersionChange = useCallback(
    (version: SeedanceV2Version) => {
      setCurrentSeedanceV2Version(version);
      // fast 不支持 1080p — 切到 fast 时若当前是 1080p 自动回落 720p。
      const clampedRes = clampSeedanceV2Resolution(version, currentSeedanceV2Resolution);
      const patch: Partial<VideoData> = { seedanceV2Version: version };
      if (clampedRes !== currentSeedanceV2Resolution) {
        patch.seedanceV2Resolution = clampedRes;
        setCurrentSeedanceV2Resolution(clampedRes);
      }
      updateCardData(card.id, patch);
      autoSave.markDirty(card.id);
    },
    [card.id, updateCardData, currentSeedanceV2Resolution],
  );

  const handleSeedanceV2ResolutionChange = useCallback(
    (resolution: SeedanceV2Resolution) => {
      // 防御: fast + 1080p 非法,钳回 720p(UI 已置灰,正常点不到)。
      const safe = clampSeedanceV2Resolution(currentSeedanceV2Version, resolution);
      setCurrentSeedanceV2Resolution(safe);
      updateCardData(card.id, { seedanceV2Resolution: safe });
      autoSave.markDirty(card.id);
    },
    [card.id, updateCardData, currentSeedanceV2Version],
  );

  const handleGrokTierChange = useCallback(
    (tier: GrokDurationTier) => {
      setCurrentGrokTier(tier);
      updateCardData(card.id, { grokTier: tier });
      autoSave.markDirty(card.id);
    },
    [card.id, updateCardData],
  );

  const handleDurationChange = useCallback(
    (val: string) => {
      const dur = Number(val);
      setCurrentDuration(dur);
      updateCardData(card.id, { duration: dur });
      autoSave.markDirty(card.id);
    },
    [card.id, updateCardData],
  );

  const handleAudioToggle = useCallback(() => {
    const next = !currentAudio;
    setCurrentAudio(next);
    updateCardData(card.id, { generateAudio: next });
    autoSave.markDirty(card.id);
  }, [card.id, currentAudio, updateCardData]);


  const onPromptChange = useCallback(
    (newContent: string, newRefs: InlineImageRef[]) => {
      updateCardData(card.id, { content: newContent, inlineRefs: newRefs });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => autoSave.markDirty(card.id), 300);
    },
    [card.id, updateCardData],
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
    const latestData = (useCardStore.getState().getCard(card.id)?.data ?? {}) as VideoData;
    const prompt = buildFinalPrompt(latestData);
    if (!prompt || generating) return;
    // 十步骨架(API Key 预检 / 进度开关 / 错误兜底)统一走 runEditorGeneration;
    // 编辑器侧只剩 prompt 守卫、build、provider 解析、几何/toast 善后。
    await runEditorGeneration(card, {
      setError,
      run: async () => {
        // 翻译逻辑(五族 tier→真实 SKU / 首尾帧·参考素材上传 / 约束校验)统一走
        // buildVideoRequest,与 cardRunner 组运行共用同一份 —— 手点和组跑发出的
        // model/body 完全一致。上传进度透传到卡片进度条;几何/善后仍留在编辑器(下方)。
        const built = await buildVideoRequest(card, {
          onUploadProgress: (kind, { uploaded, total }) =>
            setCardProgress(card.id, {
              percent: 0,
              label: `上传${kind} ${uploaded}/${total}…`,
            }),
        });
        if (!built.ok) {
          // 约束违例(参考视频/参考音频组合不合法)→ 提示并中止本次生成,不置 error 态。
          useUIStore.getState().addToast({
            type: "warning",
            title: built.toast?.title ?? "无法生成",
            description: built.toast?.description ?? built.reason,
            duration: 5000,
          });
          return;
        }

        const provider = modelService.resolveProvider(built.modelId, built.providerId);
        if (!provider.generateVideo) {
          throw new Error("当前 Provider 不支持视频生成");
        }

        const result = await provider.generateVideo({
          ...built.request,
          onProgress: (p) => {
            setCardProgress(card.id, { percent: p.percent, label: p.label });
          },
        });

        const sizeOpt = IMAGE_SIZE_OPTIONS.find((o) => o.value === currentSize);
        const cardSize = sizeOpt ? sizeFromRatio(sizeOpt.ratio) : {};
        updateCardData(card.id, { videoUrl: result.url });
        if (Object.keys(cardSize).length > 0) updateCard(card.id, cardSize);
        autoSave.markDirty(card.id);

        const isRemote = result.url.startsWith("http://") || result.url.startsWith("https://");
        if (isRemote) {
          scheduleCardMediaLocalization(card.id);
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
      },
    });
  }, [card, generating, updateCard, updateCardData, currentModel, currentSize, setCardProgress]);

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
                    loading="lazy"
                    decoding="async"
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

          {/* Seedance/Grok 上游不接受 video reference, 直接隐藏 UI.
              V138 VIP economy (sd-2-vip) 同样不支持视频参考, alias 项才能切到 -video 上游. */}
          {imageMode === "reference" && !isSeedance && !isGrok && !isVipEconomy && data.refVideos && data.refVideos.length > 0 && (
            <div className="shrink-0 rounded-lg border border-dashed border-primary/25 bg-primary/[0.03] p-2">
              <div className="mb-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                <Video className="h-3 w-3" />
                {isOmni
                  ? `源视频 · 连线的视频 (${data.refVideos.length}/1) · 视频编辑模式`
                  : `参考视频 · 连线的视频素材 (${data.refVideos.length}/3)`}
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
              <div className="flex max-h-[88px] flex-wrap gap-1.5 overflow-y-auto">
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
            quality={
              isVeo
                ? veoQuality
                : isSeedanceV2
                  ? currentSeedanceV2Version
                  : undefined
            }
            onQualityChange={
              isVeo
                ? (q: string) => handleVeoQualityChange(q as VeoQuality)
                : isSeedanceV2
                  ? (v: string) => handleSeedanceV2VersionChange(v as SeedanceV2Version)
                  : undefined
            }
            qualityOptions={
              isVeo
                ? VEO_QUALITY_TIERS.map((t) => ({ value: t.value, label: t.label }))
                : isSeedanceV2
                  ? SEEDANCE_V2_VERSION_TIERS.map((t) => ({ value: t.value, label: t.label }))
                  : undefined
            }
            resolution={
              isVeo
                ? veoResolution
                : isVipAlias
                  ? currentSeedanceVipResolution
                  : isSeedanceV2
                    ? currentSeedanceV2Resolution
                    : isSeedance
                      ? currentSeedanceTier
                      : isGrok
                        ? currentGrokTier
                        : undefined
            }
            onResolutionChange={
              isVeo
                ? (r: string) => handleVeoResolutionChange(r as VeoResolution)
                : isVipAlias
                  ? (r: string) => handleSeedanceVipResolutionChange(r as SeedanceVipResolution)
                  : isSeedanceV2
                    ? (r: string) => handleSeedanceV2ResolutionChange(r as SeedanceV2Resolution)
                    : isSeedance
                      ? (tier: string) => handleSeedanceTierChange(tier as SeedanceQualityTier)
                      : isGrok
                        ? (tier: string) => handleGrokTierChange(tier as GrokDurationTier)
                        : undefined
            }
            resolutionOptions={
              isVeo
                ? VEO_RESOLUTION_TIERS.map((t) => ({ value: t.value, label: t.label }))
                : isVipAlias
                  ? SEEDANCE_VIP_RESOLUTION_TIERS.map((t) => ({ value: t.value, label: t.label }))
                  : isSeedanceV2
                    ? SEEDANCE_V2_RESOLUTION_TIERS.map((t) => ({
                        value: t.value,
                        label: t.label,
                        disabled: !isSeedanceV2ResolutionAllowed(currentSeedanceV2Version, t.value),
                        title: isSeedanceV2ResolutionAllowed(currentSeedanceV2Version, t.value)
                          ? undefined
                          : "快速模式不支持 1080P",
                      }))
                    : isSeedance
                      ? SEEDANCE_TIERS.map((t) => ({ value: t.value, label: t.label }))
                      : isGrok
                        ? GROK_DURATION_TIERS.map((t) => ({ value: t.value, label: t.label }))
                        : undefined
            }
            duration={(isSeedance || isVeo || isSeedanceVip || isSeedanceV2) ? currentDuration : undefined}
            onDurationChange={(isSeedance || isVeo || isSeedanceVip || isSeedanceV2) ? (n) => handleDurationChange(String(n)) : undefined}
            durationOptions={(isSeedance || isVeo || isSeedanceVip || isSeedanceV2) ? effectiveDurationOptions : undefined}
            disabled={generating}
          />
        )}
        {(isSeedance || isGrok || isSeedanceV2) && !isLocked && (
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
