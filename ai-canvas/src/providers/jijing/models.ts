import type { ModelInfo } from "@/types";

export {
  isSeedanceModel as isJiJingSeedanceModel,
  isVeoModel as isJiJingVeoModel,
  isGrokVideoModel as isJiJingGrokVideoModel,
  isSeedanceVipModel as isJiJingSeedanceVipModel,
  isSeedanceV2Model as isJiJingSeedanceV2Model,
} from "../shared/video";

export const JIJING_CHAT_MODELS: ModelInfo[] = [
  { id: "gemini-3.1-pro-preview", display_name: "Gemini 3.1 Pro", capability: "CHAT" },
  // gpt-5.5-medium: 后端 ModelRouter 识别 "-medium" 后缀, 自动注入 reasoning_effort=medium,
  // 触发 Sub2API channel 1075 的 GPT-5.5 thinking 模式。显示名按用户要求仅保留 "GPT 5.5"。
  { id: "gpt-5.5-medium", display_name: "GPT 5.5", capability: "CHAT" },
];

export const JIJING_IMAGE_MODELS: ModelInfo[] = [
  { id: "gpt-image-2", display_name: "GPT Image 2", capability: "IMAGE" },
  // 官方聚合版: 原始 id 直透后端 route 2247 → 国和 (GUOHE) 单渠道, 按 token 计费, 比例×2K/4K + 质量自由选。
  //   与上面分档版 (resolveJiJingImageModelId 拆成 gpt-image-2-{q}-{res}, 走多上游) 并存;
  //   resolveJiJingImageModelId 对本 id 落 `return baseId` 不改写, 故 id 原样发出。
  { id: "gpt-image-2-official", display_name: "GPT Image 2 官方", capability: "IMAGE" },
  { id: "nano-banana-2", display_name: "Nanobanana 2", capability: "IMAGE" },
  { id: "nano-banana-pro", display_name: "Nanobanana Pro", capability: "IMAGE" },
  { id: "qwen-image-edit-2511-multipie", display_name: "Qwen 多角度", capability: "IMAGE" },
  { id: "Real-ESRGAN", display_name: "Real-ESRGAN 超分", capability: "IMAGE" },
  { id: "SeedVR2-Upscaler", display_name: "SeedVR2 高清放大", capability: "IMAGE" },
];

// 视频模型经 JiJing 网关路由,UI dropdown 露出的 canonical alias:
//   seedance-2-0      → V138/V145 alias: 后端 model_route 2223/2224/2225/2226 (Nexus 1095, 4 个上游).
//                       VideoEditor 按 (分辨率 720P/1080P, 是否传参考视频) resolve 到具体 model_name,
//                       见 resolveSeedanceVipModelId + VideoEditor.handleGenerate.
//   seedance-2-0-720p-no-person  → V145 经济版独立项 (后端 model_route 2222, sd-2-vip 上游),
//                                   不支持真人形象, 故跟 alias 拆开避免误导.
//   grok-video        → 后端 PearNo channel.
//   veo3.1            → V156 Cat 平台 6 路由 alias (channel 1098), VideoEditor 通过 tier 胶囊
//                        (fast/std/pro × 720p/1080p) 按 resolveVeoVariant resolve 到 6 个具体
//                        model_name (veo3.1-fast-720p / -720p / -pro-720p / -fast-1080p / -1080p /
//                        -pro-1080p). 三模式 (text/i2v/ref) 由 CatVideoAdapter 看 body 字段
//                        (images / referenceImages) 自动分发, 不编码在 model 里. fast 档参考图
//                        限 2 张 (Cat 上游硬约束), i2v/ref 强制 duration=8s. 见 VEO_TIERS +
//                        resolveVeoVariant + JiJingProvider.buildGatewayBody.
//
// Nexus 上游 (V145): duration 5-15 秒, 缺省 15 (canvas 暂不暴露控件); quality 字段废弃.
export const JIJING_VIDEO_MODELS: ModelInfo[] = [
  // V145: Nexus VIP alias, UI 上分辨率胶囊切 720P/1080P, 自动按是否有参考视频 resolve 到 4 个上游.
  { id: "seedance-2-0", display_name: "Seedance 2.0 VIP", capability: "VIDEO" },
  // V145: Nexus VIP 经济版独立项 (sd-2-vip 上游), 不支持真人形象, 故跟 alias 拆开避免误导.
  { id: "seedance-2-0-720p-no-person", display_name: "Seedance 2.0 经济版（不支持真人）", capability: "VIDEO" },
  // V161: 火山方舟原生 Seedance 2.0 聚合 alias, UI 切 standard/fast,
  //   按 referenceVideos 是否非空 resolve 到 4 个具体 model (seedance-2-0 / -fast / -video-ref / -fast-video-ref).
  //   计费走 PER_TOKEN_PREPAID, 提交 hasVideos 决定预扣 20/40, 实结算按 token 多退少补.
  //   见 resolveSeedanceV2ModelId + VideoEditor.handleGenerate.
  { id: "seedance-v2", display_name: "Seedance 2.0 官方", capability: "VIDEO" },
  // 以下两项 2026-05-29 起从 dropdown 隐藏 (用户决策); 后端路由 + normalize 逻辑保留,
  // 老卡片可继续 resolve/重生成。需要恢复时取消注释即可。
  // V156 Cat 平台 alias: tier 胶囊切 6 档 (fast/std/pro × 720p/1080p), 三模式 (text/i2v/ref)
  //   由后端按 body 字段自动分发. fast 档参考图限 2 张. ¥0.05-0.15/秒, 比 dbgoc/Comfly 便宜 40-60×.
  // { id: "veo3.1", display_name: "Veo 3.1", capability: "VIDEO" },
  // PearNo 后端 alias (route 2109), 时长胶囊切 12s/16s/20s → route 2106/2107/2108,
  //   resolveGrokVariant + GROK_DURATION_TIERS. 720P 固定, 支持参考图 (最多 7 张), 不支持参考音频/视频.
  // { id: "grok-video", display_name: "Grok Video", capability: "VIDEO" },
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

