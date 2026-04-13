import type { CanvasCard } from "@/stores/cardStore";

export interface RefImageSlot {
  key: string;
  label: string;
  description: string;
  required: boolean;
}

interface ModelRefConfig {
  match: RegExp;
  slots: RefImageSlot[];
}

const MODEL_REF_CONFIGS: ModelRefConfig[] = [
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
    match: /^jimeng/,
    slots: [
      { key: "refImage0", label: "参考图", description: "画面参考", required: false },
      { key: "refImage1", label: "风格参考", description: "风格迁移参考图", required: false },
    ],
  },
  {
    match: /^flux/,
    slots: [
      { key: "refImage0", label: "底图", description: "图生图的底图", required: false },
    ],
  },
  {
    match: /^nano-banana/,
    slots: [
      { key: "refImage0", label: "参考图1", description: "参考图", required: false },
      { key: "refImage1", label: "参考图2", description: "参考图", required: false },
      { key: "refImage2", label: "参考图3", description: "参考图", required: false },
      { key: "refImage3", label: "参考图4", description: "参考图", required: false },
      { key: "refImage4", label: "参考图5", description: "参考图", required: false },
    ],
  },
];

const FALLBACK_SLOTS: RefImageSlot[] = [
  { key: "refImage0", label: "参考图", description: "参考图（如模型支持）", required: false },
];

const CHAT_REF_SLOTS: RefImageSlot[] = [
  { key: "refImage0", label: "参考图1", description: "图片参考", required: false },
  { key: "refImage1", label: "参考图2", description: "图片参考", required: false },
  { key: "refImage2", label: "参考图3", description: "图片参考", required: false },
];

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

export function getRefSlotsForModel(modelId: string): RefImageSlot[] {
  if (!modelId) return FALLBACK_SLOTS;
  const cfg = MODEL_REF_CONFIGS.find((c) => c.match.test(modelId));
  return cfg?.slots ?? FALLBACK_SLOTS;
}

export interface RefImageEntry {
  url: string;
  sourceCardId?: string;
  sourceType: "file" | "card";
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

export function cardHasImage(card: CanvasCard): boolean {
  return extractCardImage(card) !== null;
}

export const CARD_REF_MIME = "application/x-canvas-card-ref";

export interface CardRefPayload {
  cardId: string;
  imageUrl: string;
  title: string;
}
