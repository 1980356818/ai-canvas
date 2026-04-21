import type { CanvasCard } from "@/types";

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
    slots: [
      { key: "refImage0", label: "参考图", description: "编辑或变体生成的参考图", required: false },
    ],
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

export function getRefSlotsForVideoModel(
  _modelId: string,
  imageMode: "frame" | "reference" = "frame",
): RefImageSlot[] {
  return imageMode === "reference" ? VIDEO_REF_SLOTS : [];
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
