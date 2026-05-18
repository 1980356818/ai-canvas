import type { ModelInfo } from "@/types";
import {
  isSeedanceModel as sharedIsSeedanceModel,
  isVeoModel as sharedIsVeoModel,
} from "../shared/video";

export { isSeedanceModel, isVeoModel } from "../shared/video";

// AI 聊天框统一走极境 (jijing) 的 chat 模型;Comfly 不再暴露 chat 入口,
// 仅保留图像/视频路径。老卡片里若还存了 comfly chat ref,streamChat 仍会
// 透传 model id 给 Comfly 后端,不主动迁移。
export const COMFLY_CHAT_MODELS: ModelInfo[] = [];

export const COMFLY_IMAGE_MODELS: ModelInfo[] = [
  { id: "gpt-image-2", display_name: "GPT Image 2", capability: "IMAGE" },
  { id: "gemini-3.1-flash-image-preview", display_name: "Nanobanana 2", capability: "IMAGE" },
  { id: "nano-banana-pro", display_name: "Nanobanana Pro", capability: "IMAGE" },
];

// 视频统一走极境 (JIJING_VIDEO_MODELS), Comfly 不再暴露 video 入口。
// ComflyProvider.generateVideo 的 seedance/veo override 保留,作老卡片透传兼容。
export const COMFLY_VIDEO_MODELS: ModelInfo[] = [];

export const ALL_COMFLY_MODELS: ModelInfo[] = [
  ...COMFLY_CHAT_MODELS,
  ...COMFLY_IMAGE_MODELS,
  ...COMFLY_VIDEO_MODELS,
];

export function resolveComflyImageModelId(baseId: string, resolution: string): string {
  if (baseId.startsWith("gemini-3.1-flash-image-preview")) {
    return resolution === "4K"
      ? "gemini-3.1-flash-image-preview-4k"
      : "gemini-3.1-flash-image-preview-2k";
  }
  if (baseId === "nano-banana-pro") {
    return resolution === "4K" ? "nano-banana-pro-4k" : "nano-banana-pro-2k";
  }
  return baseId;
}

const LEGACY_DISPLAY: Record<string, string> = {
  "doubao-seedance-2-0-v2-250528": "Seedance 2.0 (旧)",
  "doubao-seedance-2-0-v2-250528-fast": "Seedance 2.0 Fast (旧)",
  "doubao-seedance-2-0-fast-v2-250528": "Seedance 2.0 Fast (旧)",
};

export function getComflyDisplayName(modelId: string): string | undefined {
  const m = ALL_COMFLY_MODELS.find((m) => m.id === modelId);
  if (m) return m.display_name ?? m.id;
  return LEGACY_DISPLAY[modelId];
}

// Comfly-local check that also accepts legacy display IDs (older Volcano
// snapshot IDs that shouldn't be surfaced in pickers but should still match
// when re-opened from saved canvas data).
export function isComflyLegacySeedanceModel(modelId: string): boolean {
  return sharedIsSeedanceModel(modelId) || !!LEGACY_DISPLAY[modelId];
}

export const isComflyVeoModel = sharedIsVeoModel;

// ── Key slot routing ──────────────────────────────────────────
//
// Comfly 有两个固定 KEY 槽位 (default / gemini_premium)；不同上游通道。
// 把模型映射到对应槽位的规则集中放这里，前后端都引用，避免漂移。
//
// gemini_premium 走"Gemini 优质"渠道:
//   - nano-banana* (Nanobanana Pro 等)
//   - gemini-3.1-flash-image-preview* (Nanobanana 2)
//   - veo3.1* / veo-3.1*
//   - gemini-3.1-pro* (Gemini 对话)
// 其他模型一律走 default。
export type ComflyKeyTag = "default" | "gemini_premium";

export function getComflyKeyTag(modelId: string | undefined | null): ComflyKeyTag {
  if (!modelId) return "default";
  const m = modelId.toLowerCase();
  if (m.startsWith("nano-banana")) return "gemini_premium";
  if (m.startsWith("gemini-3.1-flash-image-preview")) return "gemini_premium";
  if (m.startsWith("veo3.1") || m.startsWith("veo-3.1")) return "gemini_premium";
  if (m.startsWith("gemini-3.1-pro") || m.startsWith("gemini-3.1-flash")) return "gemini_premium";
  return "default";
}
