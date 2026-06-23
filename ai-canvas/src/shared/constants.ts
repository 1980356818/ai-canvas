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
import { isSeedanceModel, isVeoModel, isGrokVideoModel, isSeedanceVipModel, isSeedanceV2AliasModel, isOmniModel } from "@/providers/shared/video";

export const IMAGE_SIZE_OPTIONS: ImageSizeOption[] = [
  { value: "1:1",   label: "1:1",   ratio: 1 },
  { value: "3:2",   label: "3:2",   ratio: 3 / 2 },
  { value: "2:3",   label: "2:3",   ratio: 2 / 3 },
  { value: "4:3",   label: "4:3",   ratio: 4 / 3 },
  { value: "3:4",   label: "3:4",   ratio: 3 / 4 },
  { value: "16:9",  label: "16:9",  ratio: 16 / 9 },
  { value: "9:16",  label: "9:16",  ratio: 9 / 16 },
  { value: "21:9",  label: "21:9",  ratio: 21 / 9 },
];

// 视频画面比例可选项 = 图片比例 + 自适应 (seedance 默认 "adaptive")。
// SizeCombo 已识别 value === "auto" 为自适应渲染，因此沿用 "auto" 作为内部值,
// providers 在出站时再翻译成各 API 期望的形式 (seedance: "adaptive"; veo: 省略)。
export const VIDEO_SIZE_OPTIONS: ImageSizeOption[] = [
  { value: "auto", label: "自适应", ratio: 1 },
  ...IMAGE_SIZE_OPTIONS,
];

export const DEFAULT_IMAGE_SIZE = IMAGE_SIZE_OPTIONS[0]!.value;
export const DEFAULT_VIDEO_SIZE = "16:9";

// ── Image quality (质量档) ────────────────────────────────────

export const IMAGE_QUALITY_OPTIONS = [
  { value: "low",    label: "低" },
  { value: "medium", label: "中" },
  { value: "high",   label: "高" },
] as const;
export type ImageQuality = (typeof IMAGE_QUALITY_OPTIONS)[number]["value"];
export const DEFAULT_IMAGE_QUALITY: ImageQuality = "medium";

export function supportsImageQuality(modelId: string, providerId?: string): boolean {
  // Comfly 的 gemini 系不支持质量档;极境 gpt-image-2 (分档版) 与 gpt-image-2-official (官方聚合版) 都支持。
  if (providerId === "comfly") return false;
  return modelId === "gpt-image-2" || modelId === "gpt-image-2-official";
}

// ── Image resolution (画质档) ────────────────────────────────
//
// 项目里合法的分辨率档位 = "1K" | "2K" | "4K"。
// 任何入口 (chat 工具调用 / agent 工具 / 卡片旧数据 / UI 选择) 拿到的 resolution
// 字符串都应该过 `normalizeResolution()`,统一收敛到这三个值之一;
// 缺省 / 不识别一律走 `DEFAULT_IMAGE_RESOLUTION` (2K),与 GPT_IMAGE_2_SIZE_MAP
// 默认档、resolveJiJingImageModelId 默认分支保持对齐。
//
// 注意:1K 仅 gpt-image-2 系开放 (后端有 -1k 分档路由 / official 按 size 走);
// nano-banana 系上游只有 2K/4K。各模型实际可选档位走 `getImageResolutionOptions()`,
// 不要直接拿 SUPPORTED_RESOLUTIONS 当 UI/价表的全集 (会给 nano-banana 冒出幻影 1K)。
export const SUPPORTED_RESOLUTIONS = ["1K", "2K", "4K"] as const;
export type ImageResolution = (typeof SUPPORTED_RESOLUTIONS)[number];
export const DEFAULT_IMAGE_RESOLUTION: ImageResolution = "2K";

export function normalizeResolution(raw: string | undefined | null): ImageResolution {
  if (raw == null) return DEFAULT_IMAGE_RESOLUTION;
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, "");
  if (s === "4K" || s === "4096" || s === "3840") return "4K";
  if (s === "1K" || s === "1024" || s === "1080") return "1K";
  return DEFAULT_IMAGE_RESOLUTION;
}

// 某图片模型在 UI/价表里实际可选的分辨率档位 (单一真相,MediaEditor 与 priceCatalog 共用)。
// 1K 仅 gpt-image-2 系 (分档版后端有 -1k 路由;official 按 size 像素计费) — 其余模型只有 2K/4K。
export function getImageResolutionOptions(modelId: string): ImageResolution[] {
  return modelId.toLowerCase().startsWith("gpt-image-2")
    ? ["1K", "2K", "4K"]
    : ["2K", "4K"];
}

const LEGACY_SIZE_MAP: Record<string, string> = {
  "auto": "1:1",
  "1024x1024": "1:1",
  "1024x1792": "9:16",
  "1792x1024": "16:9",
};

export function normalizeImageSize(raw: string | undefined): string {
  if (!raw) return DEFAULT_IMAGE_SIZE;
  if (raw.includes(":")) return raw;
  return LEGACY_SIZE_MAP[raw] ?? DEFAULT_IMAGE_SIZE;
}

// Video 单独走 normalizer: "auto" / "adaptive" 视为有效值 (seedance 自适应),
// 其余复用图像的 legacy 兜底但默认 16:9。
export function normalizeVideoSize(raw: string | undefined): string {
  if (!raw) return DEFAULT_VIDEO_SIZE;
  if (raw === "auto" || raw === "adaptive") return "auto";
  if (raw.includes(":")) return raw;
  return LEGACY_SIZE_MAP[raw] ?? DEFAULT_VIDEO_SIZE;
}

const MODEL_SIZE_CONSTRAINTS: Record<string, string[]> = {
  "gpt-image-2": ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"],
};

export function getAllowedSizesForModel(modelId: string): string[] | null {
  for (const [pattern, sizes] of Object.entries(MODEL_SIZE_CONSTRAINTS)) {
    if (modelId === pattern || modelId.startsWith(pattern)) return sizes;
  }
  return null;
}

// 视频模型可选比例 (上游 API 明确支持的). 不在此列表的会被 SizeCombo 标灰。
//   Seedance 2.0 / 2.0 fast (Dale 老路): 16:9 4:3 1:1 3:4 9:16 21:9 (UI 不再暴露 adaptive,
//     用户需明确选一个比例,避免 Dale 上游默认行为带来的不可预测尺寸)
//   Seedance 2.0 火山原生 (V161 alias `seedance-v2`): 16:9 9:16 1:1 4:3 3:4 21:9
//     (跟官方文档 https://www.volcengine.com/docs/82379/1520757 完全一致,
//      仅排除 adaptive — canvas 卡片视觉尺寸需要明确 ratio, 自适应不可控)
//   Seedance 2.0 VIP:        16:9 9:16 (Nexus form_schema 仅支持 1280x720 / 720x1280,
//     传 21:9 等会让上游 size=null 默认值跑废)
//   Veo 3.1 (Google):        16:9 9:16 1:1 (参考图模式由 VideoEditor 在 UI 层锁 16:9)
const SEEDANCE_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
const SEEDANCE_V2_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
const SEEDANCE_VIP_RATIOS = ["16:9", "9:16"] as const;
const VEO_RATIOS = ["16:9", "9:16", "1:1"] as const;
const GROK_VIDEO_RATIOS = ["16:9", "9:16", "3:2", "2:3", "1:1"] as const;
//   Omni (Veo Omni Flash): 上游仅 16:9 / 9:16 (含 omni 生成 + omni-edit 编辑)
const OMNI_RATIOS = ["16:9", "9:16"] as const;

export function getAllowedVideoSizesForModel(modelId: string): string[] | null {
  if (isSeedanceVipModel(modelId)) return [...SEEDANCE_VIP_RATIOS];
  if (isSeedanceV2AliasModel(modelId)) return [...SEEDANCE_V2_RATIOS];
  if (isSeedanceModel(modelId)) return [...SEEDANCE_RATIOS];
  if (isVeoModel(modelId)) return [...VEO_RATIOS];
  if (isGrokVideoModel(modelId)) return [...GROK_VIDEO_RATIOS];
  if (isOmniModel(modelId)) return [...OMNI_RATIOS];
  return null;
}

// Seedance / Veo 3.1: 分辨率+速度档合并为画质档 (SeedanceQualityTier / VeoQualityTier)，
// 由 VideoEditor 复用 SizeCombo.resolutionOptions 槽位渲染胶囊，不再单独提供分辨率下拉。
// Seedance 2.0 实际分辨率统一固定为 720p (480p 在画布场景几乎无用),由 VideoEditor 出站时硬编码。

export function getDefaultVideoSizeForModel(modelId: string): string {
  if (isSeedanceV2AliasModel(modelId)) return "16:9"; // V161 火山原生: 默认 16:9 (V162 SQL adaptive 默认仅在 GATEWAY API; canvas 让用户明确选比例)
  if (isSeedanceModel(modelId)) return "16:9"; // seedance 不再默认 adaptive, 与 DEFAULT_VIDEO_SIZE 一致
  return DEFAULT_VIDEO_SIZE;
}

export function coerceToAllowedSize(currentSize: string, allowedSizes: string[] | null): string {
  if (!allowedSizes) return currentSize;
  if (allowedSizes.includes(currentSize)) return currentSize;
  return allowedSizes[0] ?? DEFAULT_IMAGE_SIZE;
}

export const CARD_DEFAULTS: Record<CardType, CardDefaults> = {
  ai_chat:     { width: 680, height: 420, label: "生成文字", data: { content: "", result: "" } },
  ai_image:    { ...sizeFromRatio(IMAGE_SIZE_OPTIONS[0]!.ratio), label: "AI 图片", data: { content: "", size: IMAGE_SIZE_OPTIONS[0]!.value } },
  ai_video:    { ...sizeFromRatio(16 / 9), label: "AI 视频", data: { content: "" } },
  audio:       { width: 240, height: 80, label: "音频", data: {} },
  ai_tryon:    { ...sizeFromRatio(3 / 4), label: "模特换装", data: { content: "" } },
  ai_multiangle: { ...sizeFromRatio(1), label: "多角度", data: { content: "h:0,v:0,z:5", size: "1:1", model: "qwen-image-edit-2511-multipie", h: 0, v: 0, z: 5 } },
  text:        { ...sizeFromRatio(4 / 3), label: "文本", data: { content: "" } },
  sticky_note: { ...sizeFromRatio(5 / 4), label: "便签", data: { content: "" } },
  frame_extractor: { width: 300, height: 220, label: "关键帧提取", data: {} },
};

export const TYPE_COLORS: Record<CardType, string> = {
  ai_chat: "#3B82F6",
  ai_image: "#8B5CF6",
  ai_video: "#EF4444",
  ai_tryon: "#EC4899",
  ai_multiangle: "#14B8A6",
  text: "#6B7280",
  sticky_note: "#F59E0B",
  audio: "#F97316",
  frame_extractor: "#10B981",
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
