import type { ModelInfo } from "@/types";

export { isSeedanceModel as isJiJingSeedanceModel, isVeoModel as isJiJingVeoModel } from "../shared/video";

export const JIJING_CHAT_MODELS: ModelInfo[] = [
  { id: "gemini-3.1-pro-preview", display_name: "Gemini 3.1 Pro", capability: "CHAT" },
];

export const JIJING_IMAGE_MODELS: ModelInfo[] = [
  { id: "gpt-image-2", display_name: "GPT Image 2", capability: "IMAGE" },
  { id: "nano-banana-2", display_name: "Nanobanana 2", capability: "IMAGE" },
  { id: "nano-banana-pro", display_name: "Nanobanana Pro", capability: "IMAGE" },
  { id: "qwen-image-edit-2511-multipie", display_name: "Qwen 多角度", capability: "IMAGE" },
  { id: "Real-ESRGAN", display_name: "Real-ESRGAN 超分", capability: "IMAGE" },
  { id: "SeedVR2-Upscaler", display_name: "SeedVR2 高清放大", capability: "IMAGE" },
];

// 视频模型经 JiJing 网关路由:
//   veo3.1*  → JiJing model_route 2200..2204 → Comfly Gemini 优质 (channel 1081)
//   seedance / doubao-seedance-* → JiJing model_route 2201/2205/2206 → Comfly 普通 (channel 1080)
// 与 COMFLY_VIDEO_MODELS 一一对应，确保两路渠道在 UI 中暴露相同的变体。
export const JIJING_VIDEO_MODELS: ModelInfo[] = [
  { id: "veo3.1", display_name: "Veo 3.1", capability: "VIDEO" },
  { id: "veo3.1-fast", display_name: "Veo 3.1 Fast", capability: "VIDEO" },
  { id: "veo3.1-4k", display_name: "Veo 3.1 (4K)", capability: "VIDEO" },
  { id: "veo3.1-pro-4k", display_name: "Veo 3.1 Pro (4K)", capability: "VIDEO" },
  { id: "seedance", display_name: "Seedance 2.0", capability: "VIDEO" },
  { id: "doubao-seedance-2-0-260128", display_name: "Seedance 2.0", capability: "VIDEO" },
  { id: "doubao-seedance-2-0-fast-260128", display_name: "Seedance 2.0 Fast", capability: "VIDEO" },
];

export const ALL_JIJING_MODELS: ModelInfo[] = [
  ...JIJING_CHAT_MODELS,
  ...JIJING_IMAGE_MODELS,
  ...JIJING_VIDEO_MODELS,
];

export function resolveJiJingImageModelId(baseId: string, resolution: string): string {
  if (baseId === "nano-banana-2") {
    return resolution === "4K" ? "nano-banana-2-4k" : "nano-banana-2";
  }
  if (baseId === "nano-banana-pro") {
    return resolution === "4K" ? "nano-banana-pro-4k" : "nano-banana-pro";
  }
  // JiJing 后端没有 "gpt-image-2" 这个裸路由, 实际只有 gpt-image-2-1k / -2k / -4k / -hd。
  // 与 canvas 的分辨率选择器联动, 默认 2K (与 OpenAICompat base size map 默认值一致)。
  if (baseId === "gpt-image-2") {
    return resolution === "4K" ? "gpt-image-2-4k" : "gpt-image-2-2k";
  }
  return baseId;
}

