import type { ModelInfo } from "@/types";

export {
  isSeedanceModel as isJiJingSeedanceModel,
  isVeoModel as isJiJingVeoModel,
  isGrokVideoModel as isJiJingGrokVideoModel,
  isSeedanceVipModel as isJiJingSeedanceVipModel,
} from "../shared/video";

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

// 视频模型经 JiJing 网关路由,UI dropdown 露出的 canonical alias:
//   seedance          → 后端 model_route 2201/2205/2206 → Dale AI Seedance (channel 1094)。
//   seedance-2-0      → V138/V145 alias: 后端 model_route 2223/2224/2225/2226 (Nexus 1095, 4 个上游).
//                       VideoEditor 按 (分辨率 720P/1080P, 是否传参考视频) resolve 到具体 model_name,
//                       见 resolveSeedanceVipModelId + VideoEditor.handleGenerate.
//   seedance-2-0-720p-no-person  → V145 经济版独立项 (后端 model_route 2222, sd-2-vip 上游),
//                                   不支持真人形象, 故跟 alias 拆开避免误导.
//   grok-video        → 后端 PearNo channel.
//
// veo3.1 已从 UI dropdown 隐藏 (2026-05-24)。
// 后端 model_route 2200..2204 + isVeoModel / resolveVeoVariantForMode 等 helper 仍在,
// 用于兼容历史卡片 (model="veo3.1" 的老卡片仍能重新生成、回放),
// 但新建视频卡 / 新选模型不再露出 Veo。要重新启用,把 veo3.1 加回下面数组,
// 并把 services/models.ts getDefaultVideoModel + providerStore DEFAULT_VIDEO_REF 改回 veo3.1 即可。
//
// Dale 上游硬约束 (2026-05-16): seedance 系列不支持参考视频,UI 已屏蔽。
// Nexus 上游 (V145): duration 5-15 秒, 缺省 15 (canvas 暂不暴露控件); quality 字段废弃.
export const JIJING_VIDEO_MODELS: ModelInfo[] = [
  { id: "seedance", display_name: "Seedance 2.0 按秒计费", capability: "VIDEO" },
  // V145: Nexus VIP alias, UI 上分辨率胶囊切 720P/1080P, 自动按是否有参考视频 resolve 到 4 个上游.
  { id: "seedance-2-0", display_name: "Seedance 2.0 VIP", capability: "VIDEO" },
  // V145: Nexus VIP 经济版独立项 (sd-2-vip 上游), 不支持真人形象, 故跟 alias 拆开避免误导.
  { id: "seedance-2-0-720p-no-person", display_name: "Seedance 2.0 经济版（不支持真人）", capability: "VIDEO" },
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

