import type { ModelInfo } from "@/types";

export { isSeedanceModel as isJiJingSeedanceModel, isVeoModel as isJiJingVeoModel, isGrokVideoModel as isJiJingGrokVideoModel } from "../shared/video";

export const JIJING_CHAT_MODELS: ModelInfo[] = [
  { id: "gemini-3.1-pro-preview", display_name: "Gemini 3.1 Pro", capability: "CHAT" },
  // gpt-5.5-medium: 后端 ModelRouter 识别 "-medium" 后缀, 自动注入 reasoning_effort=medium,
  // 触发 Sub2API channel 1075 的 GPT-5.5 thinking 模式。显示名按用户要求仅保留 "GPT 5.5"。
  { id: "gpt-5.5-medium", display_name: "GPT 5.5", capability: "CHAT" },
];

export const JIJING_IMAGE_MODELS: ModelInfo[] = [
  { id: "gpt-image-2", display_name: "GPT Image 2", capability: "IMAGE" },
  { id: "nano-banana-2", display_name: "Nanobanana 2", capability: "IMAGE" },
  { id: "nano-banana-pro", display_name: "Nanobanana Pro", capability: "IMAGE" },
  { id: "qwen-image-edit-2511-multipie", display_name: "Qwen 多角度", capability: "IMAGE" },
  { id: "Real-ESRGAN", display_name: "Real-ESRGAN 超分", capability: "IMAGE" },
  { id: "SeedVR2-Upscaler", display_name: "SeedVR2 高清放大", capability: "IMAGE" },
];

// 视频模型经 JiJing 网关路由,UI dropdown 只露 2 个 canonical alias:
//   veo3.1   → 后端 model_route 2200..2204,前端按 (mode, resolution) resolve 成
//              veo3.1-fast / veo3.1-1080p / veo3.1-pro-1080p / veo3.1-ref / veo3.1-ref-hd 再发请求,
//              见 resolveVeoVariantForMode + VideoEditor.handleGenerate。
//   seedance → 后端 model_route 2201/2205/2206 → Dale AI Seedance (channel 1094)。
//
// Dale 上游硬约束 (2026-05-16): seedance 系列不支持参考视频,UI 已屏蔽。
export const JIJING_VIDEO_MODELS: ModelInfo[] = [
  { id: "veo3.1", display_name: "Veo 3.1", capability: "VIDEO" },
  { id: "seedance", display_name: "Seedance 2.0", capability: "VIDEO" },
  { id: "grok-video", display_name: "Grok Video", capability: "VIDEO" },
];

export const ALL_JIJING_MODELS: ModelInfo[] = [
  ...JIJING_CHAT_MODELS,
  ...JIJING_IMAGE_MODELS,
  ...JIJING_VIDEO_MODELS,
];

export function resolveJiJingImageModelId(baseId: string, resolution: string, quality?: string): string {
  if (baseId === "nano-banana-2") {
    return resolution === "4K" ? "nano-banana-2-4k" : "nano-banana-2-2k";
  }
  if (baseId === "nano-banana-pro") {
    return resolution === "4K" ? "nano-banana-pro-4k" : "nano-banana-pro-2k";
  }
  if (baseId === "gpt-image-2") {
    const res = resolution === "4K" ? "4k" : "2k";
    const q = quality?.toLowerCase();
    if (q && ["low", "medium", "high"].includes(q)) {
      return `gpt-image-2-${q}-${res}`;
    }
    return `gpt-image-2-medium-${res}`;
  }
  return baseId;
}

