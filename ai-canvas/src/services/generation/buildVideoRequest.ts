/**
 * 视频生成请求构建 —— 编辑器手点 / cardRunner 组运行 / agent 三路共用的唯一翻译层。
 *
 * 背景见 docs/生成统一重构施工图.md §P2.1。此前 `VideoEditor.handleGenerate` 把
 * "从 card.data 翻成 provider 请求体" 的逻辑(5 个模型族 × 首尾帧/参考两种 imageMode ×
 * tier→真实 SKU 解析)写死在编辑器里;`cardRunner` 只有一份"直接透传 canonical model"
 * 的简化版 —— 于是组跑视频发的是 canonical alias(veo3.1 / seedance)而非真实 SKU,
 * 整条线路发错 model。
 *
 * 本函数把那段翻译**逐字**搬出来做成异步函数:读 card.data → 上传素材 → 解析五族
 * tier/SKU → 拼 VideoGenRequest。**编辑器与 cardRunner 调同一份**,从结构上保证
 * 手点和组跑发出的 model/body 完全一致。
 *
 * 契约:
 *  - 约束校验**不弹 toast**,违例返回 `{ ok:false, outcome, reason, toast? }`;
 *    由调用方决定呈现 —— 编辑器弹 `toast.{title,description}`,cardRunner 用 `outcome`+`reason`。
 *  - 上传失败(网络/鉴权)直接 throw,由调用方 try/catch(编辑器 setError;cardRunner 兜成 failed)。
 *  - 几何 resize / scheduleBackgroundSave / 成功 toast 等"善后"留在编辑器,本函数不碰。
 *  - provider 解析留给调用方(编辑器 `resolveProvider` 会抛、cardRunner `tryResolveProvider` 返 undefined),
 *    本函数把解析后的 `modelId` / `providerId` 一并返回供其反查。
 *
 * 对照源:`VideoEditor.tsx` 的 `handleGenerate`(P2.1 迁移基线)。改这里务必同步比对那边。
 */

import type { CanvasCard } from "@/types";
import type { VideoGenRequest } from "@/providers/types";
import { resolveDefaultModelForCardType } from "@/services/modelDefaults";
import { useCardStore } from "@/stores/cardStore";
import { autoSave } from "@/lib/autoSave";
import { uploadMediaBatch, type MediaUploadProgress } from "@/platform/media";
import { shrinkReferenceVideoForSeedance } from "@/lib/videoCompress";
import { normalizeVideoSize } from "@/shared/constants";
import { type InlineImageRef, toDisplayText } from "@/lib/promptSerializer";
import {
  getRefSlotsForVideoModel,
  resolveVideoImageMode,
  type RefImageEntry,
} from "@/config/model-ref-images";
import {
  isSeedanceModel,
  isVeoModel,
  isGrokVideoModel,
  isSeedanceVipModel,
  isSeedanceVipAliasModel,
  isSeedanceVipEconomyModel,
  isSeedanceV2AliasModel,
  isOmniModel,
  resolveVeoVariant,
  resolveSeedanceVariantForTier,
  resolveGrokVariant,
  resolveSeedanceVipModelId,
  resolveSeedanceVipSize,
  resolveSeedanceV2ModelId,
  resolveOmniModelId,
  deriveOmniVideoType,
  clampSeedanceV2Resolution,
  VEO_TIERS,
  type VeoQualityTier,
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

interface VideoRefEntry {
  url: string;
  sourceCardId?: string;
}

interface AudioRefEntry {
  url: string;
  filename?: string;
  duration?: number;
  sourceCardId?: string;
}

/** buildVideoRequest 读取的 card.data 字段子集(与 VideoEditor.VideoData 对齐)。 */
interface VideoCardData {
  content?: string;
  inlineRefs?: InlineImageRef[];
  upstreamTexts?: Record<string, string>;
  model?: string;
  provider?: string;
  size?: string;
  veoTier?: VeoQualityTier;
  seedanceTier?: SeedanceQualityTier;
  seedanceVipResolution?: SeedanceVipResolution;
  seedanceV2Version?: SeedanceV2Version;
  seedanceV2Resolution?: SeedanceV2Resolution;
  grokTier?: GrokDurationTier;
  duration?: number;
  generateAudio?: boolean;
  imageMode?: string;
  refFrames?: VideoFrameRef[];
  /** @deprecated 旧字段,迁移到 refFrames 后仅兼容老卡片。 */
  upstreamImageUrl?: string;
  upstreamCardId?: string;
  refImages?: Record<string, RefImageEntry>;
  refAudios?: AudioRefEntry[];
  refVideos?: VideoRefEntry[];
}

export interface BuildVideoRequestOptions {
  /**
   * 上传进度回调。编辑器传写 `setCardProgress("上传X N/M…")` 的版本;
   * cardRunner / agent 传 undefined(组级进度另由 GroupLayer 显示)。
   */
  onUploadProgress?: (kind: string, progress: { uploaded: number; total: number }) => void;
}

export type BuildVideoRequestResult =
  | {
      ok: true;
      request: VideoGenRequest;
      /** 供调用方反查 provider 的 canonical model(非请求体里的真实 SKU)。 */
      modelId: string;
      providerId?: string;
    }
  | {
      ok: false;
      /** cardRunner 据此决定继续(skipped)还是中止组运行(failed)。 */
      outcome: "skipped" | "failed";
      reason: string;
      /** 编辑器据此弹 warning toast;cardRunner 忽略。 */
      toast?: { title: string; description: string };
    };

/** 拼接上游文字 + 本卡提示词(展开 inline ref 为显示文本)。与 VideoEditor.buildFinalPrompt 一致。 */
function buildFinalPrompt(data: VideoCardData): string {
  const parts: string[] = [];
  if (data.upstreamTexts) {
    for (const text of Object.values(data.upstreamTexts)) {
      if (text.trim()) parts.push(text.trim());
    }
  }
  if (data.content?.trim()) {
    parts.push(toDisplayText(data.content.trim(), data.inlineRefs ?? []));
  }
  return parts.join("\n\n");
}

/** 首尾帧来源:优先 refFrames,回退 legacy upstreamImageUrl。与 VideoEditor 的 frames useMemo 一致。 */
function resolveFrames(data: VideoCardData): VideoFrameRef[] {
  if (data.refFrames && data.refFrames.length > 0) return data.refFrames;
  if (data.upstreamImageUrl) {
    return [{ url: data.upstreamImageUrl, sourceCardId: data.upstreamCardId ?? "" }];
  }
  return [];
}

/**
 * 从一张视频卡的 data 重建 provider 请求。
 *
 * @param card 视频卡(读 card.data / card.id / card.projectId / card.type)。
 * @param opts onUploadProgress 透传到 uploadMediaBatch。
 */
export async function buildVideoRequest(
  card: CanvasCard,
  opts?: BuildVideoRequestOptions,
): Promise<BuildVideoRequestResult> {
  const data = card.data as VideoCardData;

  const prompt = buildFinalPrompt(data);
  if (!prompt) {
    return { ok: false, outcome: "skipped", reason: "缺少提示词" };
  }

  // 模型兜底:模板/批量创建 / agent / 组运行等不经过编辑器的卡,data.model 可能为空
  // (只有编辑器 on-mount 才懒赋默认)。统一走 resolveDefaultModelForCardType 单一口径
  // 并写回卡片,与编辑器"打开即补"一致。编辑器路径 data.model 必有值,不会进这里。
  let modelId = (data.model ?? "").trim();
  let providerId = data.provider;
  if (!modelId) {
    const fallback = await resolveDefaultModelForCardType(card.type);
    if (!fallback) return { ok: false, outcome: "failed", reason: "无法解析默认视频模型" };
    modelId = fallback.modelId;
    providerId = fallback.providerId;
    useCardStore.getState().updateCardData(card.id, { model: modelId, provider: providerId });
    autoSave.markDirty(card.id);
  }

  // ── 模型族判定(全部以 modelId 为输入,与编辑器以 currentModel 输入等价)──
  const isSeedance = isSeedanceModel(modelId);
  const isVeo = isVeoModel(modelId);
  const isGrok = isGrokVideoModel(modelId);
  const isSeedanceVip = isSeedanceVipModel(modelId);
  const isVipAlias = isSeedanceVipAliasModel(modelId);
  const isVipEconomy = isSeedanceVipEconomyModel(modelId);
  const isSeedanceV2 = isSeedanceV2AliasModel(modelId);
  const isOmni = isOmniModel(modelId);

  // ── tier 取值(全在 data,缺省值与 VideoEditor 初始化一致)──
  const effectiveTier: VeoQualityTier =
    isVeo && VEO_TIERS.some((t) => t.value === data.veoTier)
      ? (data.veoTier as VeoQualityTier)
      : "fast-720p";
  const seedanceTier: SeedanceQualityTier = data.seedanceTier ?? "standard";
  const seedanceVipResolution: SeedanceVipResolution = data.seedanceVipResolution ?? "720p";
  const seedanceV2Version: SeedanceV2Version = data.seedanceV2Version ?? "standard";
  // fast 不支持 1080p — 钳一道防御(陈旧卡片/agent 可能直接塞 1080p 配 fast)。
  const seedanceV2Resolution: SeedanceV2Resolution = clampSeedanceV2Resolution(
    seedanceV2Version,
    data.seedanceV2Resolution ?? "720p",
  );
  const grokTier: GrokDurationTier = data.grokTier ?? "12s";
  const duration = data.duration ?? 5;
  const generateAudio = data.generateAudio ?? true;
  const size = normalizeVideoSize(data.size);

  const imageMode = resolveVideoImageMode(data.imageMode);
  const frames = resolveFrames(data);
  const refSlots = getRefSlotsForVideoModel(modelId, imageMode, isVeo ? effectiveTier : undefined);

  // 上传进度桥:把 (kind) 包成 uploadMediaBatch 的 onProgress。
  const reportUpload = (
    kind: string,
  ): ((p: MediaUploadProgress) => void) | undefined =>
    opts?.onUploadProgress
      ? ({ uploaded, total }: MediaUploadProgress) =>
          opts.onUploadProgress!(kind, { uploaded, total })
      : undefined;

  const referenceImages: Array<{ url: string; role: string }> = [];
  const referenceAudios: Array<{ url: string; role: string }> = [];
  const referenceVideos: Array<{ url: string; role: string }> = [];

  // 上传统一用 uploadMediaBatch(fail-fast)。首尾帧: 1 张 = 首帧, 2 张 = 首+尾帧。
  if (imageMode === "firstLastFrame") {
    const uploaded = await uploadMediaBatch(frames.map((f) => f.url), {
      onProgress: reportUpload("首尾帧"),
    });
    uploaded.forEach((url, i) => {
      referenceImages.push({ url, role: i === 0 ? "firstFrame" : "lastFrame" });
    });
  } else if (imageMode === "reference") {
    const refEntries = refSlots
      .map((slot) => data.refImages?.[slot.key])
      .filter((e): e is RefImageEntry => Boolean(e));
    const uploadedRefImages = await uploadMediaBatch(refEntries.map((entry) => entry.url), {
      onProgress: reportUpload("参考图"),
    });
    uploadedRefImages.forEach((url) => {
      referenceImages.push({ url, role: "referenceImage" });
    });

    if (data.refAudios?.length) {
      const uploadedAudios = await uploadMediaBatch(data.refAudios.map((entry) => entry.url), {
        onProgress: reportUpload("参考音频"),
      });
      uploadedAudios.forEach((url) => {
        referenceAudios.push({ url, role: "referenceAudio" });
      });
    }
    // Seedance/Grok 上游硬约束: 拒绝 video reference。
    if ((isSeedance || isGrok) && data.refVideos?.length) {
      return {
        ok: false,
        outcome: "skipped",
        reason: "该模型不支持参考视频",
        toast: {
          title: "该模型不支持参考视频",
          description: "请改用参考图，或切换到其他模型",
        },
      };
    }
    if (data.refVideos?.length) {
      // Seedance r2v(火山 doubao-seedance-2-0:V161 原生 / V145 Nexus)对参考视频有
      // 单帧像素上限,提交前等比缩到临界点下(已达标不动)。其余族(omni 等上游不同)
      // 不缩。详见 docs/r2v参考视频像素压缩-设计与施工图.md。
      const shrinkVideos = isSeedanceV2 || isSeedanceVip;
      let refVideoUrls: string[];
      if (shrinkVideos) {
        // 压缩可能要几秒(4K 再编码),先报一个阶段让进度条不显得卡住。
        opts?.onUploadProgress?.("压缩参考视频", { uploaded: 0, total: data.refVideos.length });
        refVideoUrls = await Promise.all(
          data.refVideos.map((entry) => shrinkReferenceVideoForSeedance(entry.url)),
        );
      } else {
        refVideoUrls = data.refVideos.map((entry) => entry.url);
      }
      const uploadedVideos = await uploadMediaBatch(refVideoUrls, {
        onProgress: reportUpload("参考视频"),
      });
      uploadedVideos.forEach((url) => {
        referenceVideos.push({ url, role: "referenceVideo" });
      });
    }
    if (isSeedance && referenceAudios.length > 0 && referenceImages.length === 0) {
      return {
        ok: false,
        outcome: "skipped",
        reason: "参考音频不能单独使用",
        toast: {
          title: "参考音频不能单独使用",
          description: "Seedance 要求参考音频必须搭配参考图一起使用，请先添加图片素材",
        },
      };
    }
    // Grok 不支持参考音频,有的话直接清空(不打断生成流程)。
    if (isGrok) {
      referenceAudios.length = 0;
    }
  }

  // ── 真实 SKU 解析(canvas 只存 canonical alias,这里按 tier/分辨率/是否含视频参考分流)──
  // Veo: canonical "veo3.1" → Cat 6 档画质×分辨率 SKU,三模式(text/i2v/ref)由后端看 body 字段分发。
  // Seedance(Dale): canonical "seedance" → "seedance" / "seedance-fast"。
  // Grok: "grok-video" → -12s / -16s / -20s。
  // VIP alias(Nexus): "seedance-2-0" → 按(分辨率, 是否传视频)resolve 到 4 个上游。
  // VIP economy: 单独 model_name,原样透传。
  // V2 alias(火山原生): "seedance-v2" → 按(version × 是否传视频)4 路分发。
  const hasReferenceVideos = referenceVideos.length > 0;
  const effectiveModel = isVeo
    ? resolveVeoVariant(effectiveTier)
    : isSeedance
      ? resolveSeedanceVariantForTier(seedanceTier)
      : isGrok
        ? resolveGrokVariant(grokTier)
        : isVipAlias
          ? resolveSeedanceVipModelId(seedanceVipResolution, hasReferenceVideos)
          : isSeedanceV2
            ? resolveSeedanceV2ModelId(seedanceV2Version, hasReferenceVideos)
            : isOmni
              ? resolveOmniModelId(hasReferenceVideos)
              : modelId;
  // VIP: size 必须是具体像素(720P→1280x720/720x1280, 1080P→1920x1080/1080x1920)。
  const effectiveSize = isVipAlias
    ? resolveSeedanceVipSize(seedanceVipResolution, size)
    : isVipEconomy
      ? resolveSeedanceVipSize("720p", size)
      : size;
  // Veo 用户选 4/6/8,后端在 i2v/ref 模式自动强制 8。Grok 时长编码在 SKU 里,不传 duration。
  const effectiveDuration =
    isVeo || isSeedance || isSeedanceVip || isSeedanceV2 ? duration : undefined;

  const request: VideoGenRequest = {
    prompt,
    model: effectiveModel || undefined,
    size: effectiveSize,
    referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
    referenceAudios: referenceAudios.length > 0 ? referenceAudios : undefined,
    referenceVideos: referenceVideos.length > 0 ? referenceVideos : undefined,
    duration: effectiveDuration,
    // Seedance(Dale): 固定 720p。V2(火山官方): 用户选 480/720/1080(fast 已钳除 1080)。
    // 其余族编码在 SKU 或只读 size,不发 resolution。
    resolution: isSeedance ? "720p" : isSeedanceV2 ? seedanceV2Resolution : undefined,
    // Veo 协议无 generate_audio 字段;Seedance/Grok/V2 才透传有声/无声。
    generateAudio: isSeedance || isGrok || isSeedanceV2 ? generateAudio : undefined,
    // omni 生成态: 由 imageMode + 参考图数量派生 t2v/i2v/r2v。omni-edit (有源视频) 与其它族不发。
    videoType: isOmni && !hasReferenceVideos
      ? deriveOmniVideoType(imageMode, referenceImages.length)
      : undefined,
    cardId: card.id,
    projectId: card.projectId,
  };

  return { ok: true, request, modelId, providerId };
}
