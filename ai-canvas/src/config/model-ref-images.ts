import type { CanvasCard } from "@/types";
import { isSeedanceModel, isVeoModel, isGrokVideoModel, isOmniModel, type VeoQualityTier } from "@/providers/shared/video";

export interface RefImageSlot {
  key: string;
  label: string;
  description: string;
  required: boolean;
}

interface ModelRefConfig {
  match: RegExp;
  slots: RefImageSlot[];
  /** True for image-enhancer models that need no prompt (e.g. super-resolution). */
  enhancer?: boolean;
}

const MODEL_REF_CONFIGS: ModelRefConfig[] = [
  {
    match: /^Real-ESRGAN$|^SeedVR2-Upscaler$/,
    enhancer: true,
    slots: [
      { key: "refImage0", label: "待放大图片", description: "上传需要高清放大的图片（必填）", required: true },
    ],
  },
  {
    match: /^gpt-image/,
    slots: Array.from({ length: 8 }, (_, i) => ({
      key: `refImage${i}`,
      label: `参考图${i + 1}`,
      description: "编辑或变体生成的参考图",
      required: false,
    })),
  },
  {
    match: /^grok.*image/,
    slots: [
      { key: "refImage0", label: "参考图", description: "风格或内容参考", required: false },
    ],
  },
  {
    match: /^firered/,
    slots: [
      { key: "refImage0", label: "参考图", description: "需要编辑的原图", required: false },
    ],
  },
  {
    match: /^nano-banana|^gemini-3\.1-flash-image-preview/,
    slots: Array.from({ length: 14 }, (_, i) => ({
      key: `refImage${i}`,
      label: `参考图${i + 1}`,
      description: "参考图",
      required: false,
    })),
  },
];

const FALLBACK_SLOTS: RefImageSlot[] = Array.from({ length: 10 }, (_, i) => ({
  key: `refImage${i}`,
  label: `参考图${i + 1}`,
  description: "参考图（如模型支持）",
  required: false,
}));

const CHAT_REF_SLOTS: RefImageSlot[] = Array.from({ length: 12 }, (_, i) => ({
  key: `refImage${i}`,
  label: `参考图${i + 1}`,
  description: "图片参考",
  required: false,
}));

// Seedance 2.0 多模态参考: 0~9 张
const SEEDANCE_VIDEO_REF_SLOTS: RefImageSlot[] = Array.from({ length: 9 }, (_, i) => ({
  key: `refImage${i}`,
  label: `参考图${i + 1}`,
  description: "Seedance 多模态参考图",
  required: false,
}));

// Veo 3.1 参考模式 (ref / type=3): Cat 上游 std/pro 1-3 张, fast 限 2 张.
// fast 档由 getRefSlotsForVideoModel 截取前 2 个 slot 实现.
const VEO_REF_VIDEO_REF_SLOTS: RefImageSlot[] = [
  { key: "refImage0", label: "参考图 1", description: "角色 / 道具 / 场景参考", required: false },
  { key: "refImage1", label: "参考图 2", description: "角色 / 道具 / 场景参考", required: false },
  { key: "refImage2", label: "参考图 3", description: "角色 / 道具 / 场景参考", required: false },
];

// Grok Video: 上游 PearNo 支持最多 7 张参考图
const GROK_VIDEO_REF_SLOTS: RefImageSlot[] = Array.from({ length: 7 }, (_, i) => ({
  key: `refImage${i}`,
  label: `参考图${i + 1}`,
  description: "Grok 视频参考图",
  required: false,
}));

// Omni (Veo Omni Flash) r2v 参考图: 上游最多 7 张 (i2v 走 refFrames 通道, 不用 slot)
const OMNI_R2V_SLOTS: RefImageSlot[] = Array.from({ length: 7 }, (_, i) => ({
  key: `refImage${i}`,
  label: `参考图${i + 1}`,
  description: "Omni 参考图 (风格 / 对象参考)",
  required: false,
}));

// 兜底: 通用视频参考图槽位
const VIDEO_REF_SLOTS: RefImageSlot[] = Array.from({ length: 9 }, (_, i) => ({
  key: `refImage${i}`,
  label: `参考图${i + 1}`,
  description: "视频参考图",
  required: false,
}));

const NON_VISION_PATTERNS: RegExp[] = [
  /^spark/i,
  /^ernie[_-]?(lite|speed|tiny)/i,
  /^abab[_-]?\d/i,
  /^hunyuan[_-]?lite/i,
];

export function modelSupportsVision(modelId: string): boolean {
  if (!modelId) return true;
  if (/vision|\bvl\b/i.test(modelId)) return true;
  return !NON_VISION_PATTERNS.some((p) => p.test(modelId));
}

export function getRefSlotsForChatModel(modelId: string): RefImageSlot[] {
  if (!modelSupportsVision(modelId)) return [];
  return CHAT_REF_SLOTS;
}

// ─── Video imageMode: single source of truth ────────────────────────────────
//
// 视频卡片有且仅有两种图片输入模式。所有读取 imageMode 的代码（dataFlow 注入 /
// canAcceptConnection 验证 / VideoEditor 渲染）必须统一走这里,禁止内联默认值。
// 历史卡片可能存有 "firstFrame" / "frame" / "text" 等废弃值,一律归并到 firstLastFrame。

export type VideoImageMode = "firstLastFrame" | "reference";

export const DEFAULT_VIDEO_IMAGE_MODE: VideoImageMode = "firstLastFrame";

export function resolveVideoImageMode(raw: string | undefined | null): VideoImageMode {
  if (raw === "firstLastFrame" || raw === "reference") return raw;
  return DEFAULT_VIDEO_IMAGE_MODE;
}

export function getRefSlotsForVideoModel(
  modelId: string,
  imageMode?: string,
  veoTier?: VeoQualityTier,
): RefImageSlot[] {
  if (resolveVideoImageMode(imageMode) !== "reference") return [];
  if (isSeedanceModel(modelId)) return SEEDANCE_VIDEO_REF_SLOTS;
  if (isVeoModel(modelId)) {
    // Cat 上游: fast 档 1-2 张, std/pro 1-3 张. fast 档截取前 2 个 slot.
    if (veoTier === "fast-720p" || veoTier === "fast-1080p") {
      return VEO_REF_VIDEO_REF_SLOTS.slice(0, 2);
    }
    return VEO_REF_VIDEO_REF_SLOTS;
  }
  if (isGrokVideoModel(modelId)) return GROK_VIDEO_REF_SLOTS;
  if (isOmniModel(modelId)) return OMNI_R2V_SLOTS;
  return VIDEO_REF_SLOTS;
}

export function getRefSlotsForModel(modelId: string): RefImageSlot[] {
  if (!modelId) return FALLBACK_SLOTS;
  const cfg = MODEL_REF_CONFIGS.find((c) => c.match.test(modelId));
  return cfg?.slots ?? FALLBACK_SLOTS;
}

export function isEnhancerModel(modelId: string): boolean {
  if (!modelId) return false;
  const cfg = MODEL_REF_CONFIGS.find((c) => c.match.test(modelId));
  return cfg?.enhancer === true;
}

const MULTIANGLE_PATTERN = /^qwen-image-edit.*multipie$/;

export function isMultiangleModel(modelId: string): boolean {
  if (!modelId) return false;
  return MULTIANGLE_PATTERN.test(modelId);
}

export function isStandardImageModel(modelId: string): boolean {
  return !isEnhancerModel(modelId) && !isMultiangleModel(modelId);
}

export interface RefImageEntry {
  url: string;
  sourceCardId?: string;
  sourceType: "file" | "card";
  width?: number;
  height?: number;
}

/**
 * Compact ref images so there are no gaps between slots.
 * e.g. if refImage0 and refImage2 exist, refImage2 becomes refImage1.
 */
export function compactRefImages(
  refImages: Record<string, RefImageEntry>,
  slots: RefImageSlot[],
): Record<string, RefImageEntry> {
  const entries = slots
    .map((s) => refImages[s.key])
    .filter((e): e is RefImageEntry => !!e);
  const result: Record<string, RefImageEntry> = {};
  entries.forEach((entry, i) => {
    if (slots[i]) result[slots[i].key] = entry;
  });
  return result;
}

/**
 * Build a mapping from old slot keys to new slot keys after compaction.
 * Returns a Map where key = old slotKey, value = new slotKey.
 * Only includes entries whose key actually changed.
 */
export function buildCompactKeyMap(
  refImages: Record<string, RefImageEntry>,
  slots: RefImageSlot[],
): Map<string, string> {
  const occupied = slots.filter((s) => refImages[s.key]);
  const map = new Map<string, string>();
  occupied.forEach((slot, i) => {
    const newKey = slots[i]!.key;
    if (slot.key !== newKey) {
      map.set(slot.key, newKey);
    }
  });
  return map;
}

export function extractCardImage(card: CanvasCard): string | null {
  const d = card.data as Record<string, unknown>;
  switch (card.type) {
    case "ai_image":
    case "ai_multiangle":
      return (d.imageUrl as string) || null;
    case "ai_tryon":
      return (
        (d.resultImageUrl as string) ||
        (d.personImageUrl as string) ||
        (d.garmentImageUrl as string) ||
        null
      );
    default:
      return null;
  }
}

export function extractCardMedia(card: CanvasCard): string | null {
  const imageUrl = extractCardImage(card);
  if (imageUrl) return imageUrl;
  if (card.type === "ai_video") {
    const d = card.data as Record<string, unknown>;
    return (d.videoUrl as string) || null;
  }
  return null;
}

export function cardHasMedia(card: CanvasCard): boolean {
  return extractCardMedia(card) !== null;
}

export function cardHasImage(card: CanvasCard): boolean {
  return extractCardImage(card) !== null;
}

export const CARD_REF_MIME = "application/x-canvas-card-ref";

export interface CardRefPayload {
  cardId: string;
  imageUrl: string;
  title: string;
}
