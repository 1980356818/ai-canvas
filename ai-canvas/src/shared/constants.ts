import type { CardType, CardDefaults } from "@/types";

export type { CardDefaults } from "@/types";

export const CARD_MAX_EDGE = 340;

export const BIRDVIEW_ENTER_ZOOM = 0.22;
export const BIRDVIEW_EXIT_ZOOM = 0.28;

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 5;

export function sizeFromRatio(ratio: number): { width: number; height: number } {
  if (ratio >= 1) {
    return { width: CARD_MAX_EDGE, height: Math.round(CARD_MAX_EDGE / ratio) };
  }
  return { width: Math.round(CARD_MAX_EDGE * ratio), height: CARD_MAX_EDGE };
}

export type { ImageSizeOption, QuickCreateItem, WorkflowCardPreset, WorkflowConnectionPreset, WorkflowTemplate } from "@/types";
import type { ImageSizeOption } from "@/types";

export const IMAGE_SIZE_OPTIONS: ImageSizeOption[] = [
  { value: "auto",  label: "自适应", ratio: 1 },
  { value: "1:1",   label: "1:1",   ratio: 1 },
  { value: "3:2",   label: "3:2",   ratio: 3 / 2 },
  { value: "2:3",   label: "2:3",   ratio: 2 / 3 },
  { value: "4:3",   label: "4:3",   ratio: 4 / 3 },
  { value: "3:4",   label: "3:4",   ratio: 3 / 4 },
  { value: "16:9",  label: "16:9",  ratio: 16 / 9 },
  { value: "9:16",  label: "9:16",  ratio: 9 / 16 },
  { value: "21:9",  label: "21:9",  ratio: 21 / 9 },
];

export const DEFAULT_IMAGE_SIZE = IMAGE_SIZE_OPTIONS[0]!.value;

const LEGACY_SIZE_MAP: Record<string, string> = {
  "1024x1024": "1:1",
  "1024x1792": "9:16",
  "1792x1024": "16:9",
};

export function normalizeImageSize(raw: string | undefined): string {
  if (!raw) return DEFAULT_IMAGE_SIZE;
  if (raw.includes(":")) return raw;
  return LEGACY_SIZE_MAP[raw] ?? DEFAULT_IMAGE_SIZE;
}

export const CARD_DEFAULTS: Record<CardType, CardDefaults> = {
  ai_chat:     { width: 680, height: 420, label: "生成文字", data: { content: "", result: "" } },
  ai_image:    { ...sizeFromRatio(IMAGE_SIZE_OPTIONS[0]!.ratio), label: "AI 图片", data: { content: "", size: IMAGE_SIZE_OPTIONS[0]!.value } },
  ai_video:    { ...sizeFromRatio(16 / 9), label: "AI 视频", data: { content: "" } },
  ai_tryon:    { ...sizeFromRatio(3 / 4), label: "AI 换装", data: { content: "" } },
  ai_multiangle: { ...sizeFromRatio(1), label: "多角度", data: { content: "h:0,v:0,z:5", size: "1:1", model: "qwen-image-edit-2511-multipie", h: 0, v: 0, z: 5 } },
  text:        { ...sizeFromRatio(4 / 3), label: "文本", data: { content: "" } },
  sticky_note: { ...sizeFromRatio(5 / 4), label: "便签", data: { content: "" } },
};

export const TYPE_COLORS: Record<CardType, string> = {
  ai_chat: "#3B82F6",
  ai_image: "#8B5CF6",
  ai_video: "#EF4444",
  ai_tryon: "#EC4899",
  ai_multiangle: "#14B8A6",
  text: "#6B7280",
  sticky_note: "#F59E0B",
};

export const CARD_COLOR_PRESETS = [
  { name: "无", value: "" },
  { name: "红色", value: "#EF4444" },
  { name: "橙色", value: "#F97316" },
  { name: "黄色", value: "#EAB308" },
  { name: "绿色", value: "#22C55E" },
  { name: "蓝色", value: "#3B82F6" },
  { name: "紫色", value: "#8B5CF6" },
  { name: "粉色", value: "#EC4899" },
];

// WORKFLOW_TEMPLATES lives in @/config/workflows.ts — import directly to avoid circular deps
