import type { ModelInfo } from "@/types";

export { isSeedanceModel as isJiJingSeedanceModel, isVeoModel as isJiJingVeoModel } from "../shared/video";

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

// 视频模型经 JiJing 网关路由:
//   veo3.1*  → JiJing model_route 2200..2204 → dbgoc Veo 3.1 (channel 1092)
//   seedance / doubao-seedance-* → JiJing model_route 2201/2205/2206 → Dale AI Seedance (channel 1094, V114, 2026-05-16)
//     备份: Comfly 普通 (实际是 channel 1082, V114 已 enabled=0 屏蔽)。
// 与 COMFLY_VIDEO_MODELS 一一对应，确保两路渠道在 UI 中暴露相同的变体。
//
// 注意 (Dale 上游硬约束, 2026-05-16 实测):
//   - seedance-2.0-fast / seedance-2-0 都 **不支持参考视频** (video_file_*),
//     UI 必须屏蔽 referenceVideos 入口, 见 VideoEditor.tsx + jijing/index.ts 的 guard.
//   - 参考图 / 参考音频 / 文生视频 / 图生视频 都正常.
//   - 上游 per-second 计费 fast 0.6/s, 标准 0.8/s.
export const JIJING_VIDEO_MODELS: ModelInfo[] = [
  { id: "veo3.1", display_name: "Veo 3.1", capability: "VIDEO" },
  { id: "veo3.1-fast", display_name: "Veo 3.1 Fast", capability: "VIDEO" },
  { id: "veo3.1-4k", display_name: "Veo 3.1 1080p", capability: "VIDEO" },
  { id: "veo3.1-pro-4k", display_name: "Veo 3.1 1080p Pro", capability: "VIDEO" },
  { id: "veo3.1-ref", display_name: "Veo 3.1 参考图", capability: "VIDEO" },
  { id: "veo3.1-ref-hd", display_name: "Veo 3.1 参考图 1080p", capability: "VIDEO" },
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
    return resolution === "4K" ? "nano-banana-2-4k" : "nano-banana-2-2k";
  }
  if (baseId === "nano-banana-pro") {
    return resolution === "4K" ? "nano-banana-pro-4k" : "nano-banana-pro-2k";
  }
  // JiJing 后端没有 "gpt-image-2" 这个裸路由, 实际只有 gpt-image-2-1k / -2k / -4k / -hd。
  // 与 canvas 的分辨率选择器联动, 默认 2K (与 OpenAICompat base size map 默认值一致)。
  if (baseId === "gpt-image-2") {
    return resolution === "4K" ? "gpt-image-2-4k" : "gpt-image-2-2k";
  }
  return baseId;
}

