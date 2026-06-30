/**
 * Cross-provider video model utilities.
 *
 * Both ComflyProvider (direct) and JiJingProvider (gateway) expose Veo /
 * Seedance under the same canonical aliases. UI components and providers
 * should import from here instead of provider-local files so the routing
 * decision stays consistent regardless of which platform is selected.
 *
 * Canonical aliases:
 *   "veo3.1"   → Google Veo 3.1 family
 *   "seedance" → Volcano (Doubao) Seedance 2.0 family
 *
 * Concrete upstream variant IDs (e.g. "veo3.1-fast", "doubao-seedance-2-0-260128")
 * also match so existing model lists keep working.
 */

const SEEDANCE_LEGACY_IDS = new Set<string>([
  "doubao-seedance-2-0-v2-250528",
  "doubao-seedance-2-0-v2-250528-fast",
  "doubao-seedance-2-0-fast-v2-250528",
]);

export function isSeedanceModel(modelId: string | undefined | null): boolean {
  if (!modelId) return false;
  if (modelId === "seedance" || modelId === "seedance-fast") return true;
  if (modelId.startsWith("doubao-seedance")) return true;
  if (SEEDANCE_LEGACY_IDS.has(modelId)) return true;
  return false;
}

export function isVeoModel(modelId: string | undefined | null): boolean {
  if (!modelId) return false;
  if (modelId === "veo3.1") return true;
  if (modelId.startsWith("veo3.1") || modelId.startsWith("veo-3.1")) return true;
  return false;
}

export function isGrokVideoModel(modelId: string | undefined | null): boolean {
  if (!modelId) return false;
  return modelId === "grok-video" || modelId.startsWith("grok-video-");
}

export function isVideoGenModel(modelId: string | undefined | null): boolean {
  return isSeedanceModel(modelId) || isVeoModel(modelId) || isGrokVideoModel(modelId);
}

/**
 * Resolve a canvas-facing canonical alias to the upstream model ID the
 * comfly direct API expects. JiJing gateway calls send the canonical alias
 * and the backend ModelRouter picks the upstream variant via line_tag.
 */
export function resolveSeedanceUpstreamModel(modelId: string | undefined): string {
  if (!modelId) return "doubao-seedance-2-0-260128";
  switch (modelId) {
    case "seedance":
      return "doubao-seedance-2-0-260128";
    case "seedance-fast":
      return "doubao-seedance-2-0-fast-260128";
    case "doubao-seedance-2-0-v2-250528":
      return "doubao-seedance-2-0-260128";
    case "doubao-seedance-2-0-v2-250528-fast":
    case "doubao-seedance-2-0-fast-v2-250528":
      return "doubao-seedance-2-0-fast-260128";
    default:
      return modelId;
  }
}

/**
 * Canvas 现在统一发 Cat 命名的 Veo SKU (resolveVeoVariant 的输出, 见下方 VEO_TIERS).
 * ComflyProvider 直连 Comfly API, 上游用旧 SKU 命名 (veo3.1-fast / veo3.1-1080p /
 * veo3.1-pro-1080p), 这里把 Cat 6 档映射回 Comfly 近似 SKU.
 * Comfly 没有独立 720p std/pro 档, 720p 三档统一 fallback 到 veo3.1-fast.
 * JiJingProvider 不走这条 helper, 它直接透传 Cat 命名.
 */
export function resolveVeoUpstreamModel(modelId: string | undefined): string {
  if (!modelId || modelId === "veo3.1") return "veo3.1-fast";
  switch (modelId) {
    case "veo3.1-fast-720p":
    case "veo3.1-720p":
    case "veo3.1-pro-720p":
      return "veo3.1-fast";
    case "veo3.1-fast-1080p":
    case "veo3.1-1080p":
      return "veo3.1-1080p";
    case "veo3.1-pro-1080p":
      return "veo3.1-pro-1080p";
    default:
      return modelId;
  }
}

/**
 * Seedance 2.0 画质档 — UI 胶囊选择器直接对应的值。
 *
 * 返回的是 JiJing 后端 `model_route.model_name` 里实际存在的精确 SKU，而不是
 * canonical alias `seedance`/`seedance-fast` —— 因为 JiJingProvider 不做 alias
 * 解析，把 `req.model` 原样塞 body 给网关，只有精确 SKU 才能命中路由表：
 *   Route 2206  `doubao-seedance-2-0-fast-260128` → Dale 1094 (fast)
 *   Route 2205  `doubao-seedance-2-0-260128`      → Dale 1094 (标准)
 * 不走 Route 2201 (`seedance`)，因为它同时挂了 fast+标准两个 upstream
 * (priority 都是 5)，picker 行为不可控。
 * Comfly 这边走 `resolveSeedanceUpstreamModel` 的 default 分支原样透传，精确
 * SKU 同样直接被 Volcano API 接受 —— 两条 provider 链路都跑得通。
 */
export type SeedanceQualityTier = "fast" | "standard";

export const SEEDANCE_TIERS: readonly { value: SeedanceQualityTier; label: string; price: string }[] = [
  { value: "fast",     label: "快速", price: "0.5" },
  { value: "standard", label: "标准", price: "1.0" },
];

export function resolveSeedanceVariantForTier(tier: SeedanceQualityTier): string {
  return tier === "fast"
    ? "doubao-seedance-2-0-fast-260128"
    : "doubao-seedance-2-0-260128";
}

/**
 * 从历史卡片的 model SKU 推断画质档。
 * UI 引入 tier 之前所有 canvas 卡片都跑标准版（"seedance" 直接 resolve 到
 * doubao-seedance-2-0-260128），因此默认 standard，避免历史复现意外变成 fast。
 */
export function inferSeedanceTierFromLegacy(
  modelId: string | undefined | null,
): SeedanceQualityTier {
  if (!modelId) return "standard";
  const m = modelId.toLowerCase();
  if (m === "seedance-fast") return "fast";
  if (m.includes("fast")) return "fast";
  return "standard";
}

/**
 * Veo 3.1 画质 × 分辨率档 — Cat 平台 6 档, UI 胶囊选择.
 *
 * tier → JiJing 网关 model_route.model_name (prod DB 2026-05-29 实测, 无 -cat 后缀):
 *   fast-720p    → veo3.1-fast-720p    (¥0.05/秒, ~60s)
 *   std-720p     → veo3.1-720p         (¥0.08/秒, ~57s)
 *   pro-720p     → veo3.1-pro-720p     (¥0.10/秒, ~66s)
 *   fast-1080p   → veo3.1-fast-1080p   (¥0.10/秒, ~70s)
 *   std-1080p    → veo3.1-1080p        (¥0.12/秒, ~70s)
 *   pro-1080p    → veo3.1-pro-1080p    (¥0.15/秒, ~80s)
 *
 * 三模式分发由后端 CatVideoAdapter 看 body 字段决定 (不编码在 tier 里):
 *   无图                     → type=1 纯文生, duration 4/6/8 自由
 *   body.images 非空         → type=2 首尾帧 i2v, adapter 强制 duration=8
 *   body.referenceImages 非空 → type=3 参考 ref (multipart), adapter 强制 duration=8
 *                                fast 限 2 张参考图, std/pro 1-3 张
 * 优先级: referenceImages > images > 纯文本.
 */
export type VeoQualityTier =
  | "fast-720p"
  | "std-720p"
  | "pro-720p"
  | "fast-1080p"
  | "std-1080p"
  | "pro-1080p";

export const VEO_TIERS: readonly { value: VeoQualityTier; label: string; price: string }[] = [
  { value: "fast-720p",  label: "快速 720P",  price: "0.05" },
  { value: "std-720p",   label: "标准 720P",  price: "0.08" },
  { value: "pro-720p",   label: "Pro 720P",   price: "0.10" },
  { value: "fast-1080p", label: "快速 1080P", price: "0.10" },
  { value: "std-1080p",  label: "标准 1080P", price: "0.12" },
  { value: "pro-1080p",  label: "Pro 1080P",  price: "0.15" },
];

/** Veo 画质维度: fast / std / pro. UI 上和分辨率分开成两个胶囊. */
export type VeoQuality = "fast" | "std" | "pro";

/** Veo 分辨率维度: 720p / 1080p. */
export type VeoResolution = "720p" | "1080p";

export const VEO_QUALITY_TIERS: readonly { value: VeoQuality; label: string }[] = [
  { value: "fast", label: "快速" },
  { value: "std",  label: "标准" },
  { value: "pro",  label: "Pro" },
];

export const VEO_RESOLUTION_TIERS: readonly { value: VeoResolution; label: string }[] = [
  { value: "720p",  label: "720P" },
  { value: "1080p", label: "1080P" },
];

/** 把(画质, 分辨率)拼成 VeoQualityTier (Cat 6 档 SKU). */
export function composeVeoTier(quality: VeoQuality, resolution: VeoResolution): VeoQualityTier {
  return `${quality}-${resolution}` as VeoQualityTier;
}

/** 把 VeoQualityTier 拆成(画质, 分辨率), 给 UI 两个胶囊 state 用. */
export function decomposeVeoTier(tier: VeoQualityTier): { quality: VeoQuality; resolution: VeoResolution } {
  switch (tier) {
    case "fast-720p":  return { quality: "fast", resolution: "720p" };
    case "std-720p":   return { quality: "std",  resolution: "720p" };
    case "pro-720p":   return { quality: "pro",  resolution: "720p" };
    case "fast-1080p": return { quality: "fast", resolution: "1080p" };
    case "std-1080p":  return { quality: "std",  resolution: "1080p" };
    case "pro-1080p":  return { quality: "pro",  resolution: "1080p" };
  }
}

/** tier → Cat 6 个干净 model_name 之一. 模式由 imageMode + 参考图字段决定. */
export function resolveVeoVariant(tier: VeoQualityTier): string {
  switch (tier) {
    case "fast-720p":  return "veo3.1-fast-720p";
    case "std-720p":   return "veo3.1-720p";
    case "pro-720p":   return "veo3.1-pro-720p";
    case "fast-1080p": return "veo3.1-fast-1080p";
    case "std-1080p":  return "veo3.1-1080p";
    case "pro-1080p":  return "veo3.1-pro-1080p";
  }
}

/** fast 档参考图上限 (Cat 上游硬约束: fast 1-2 张, std/pro 1-3 张). */
export function veoRefImageMaxCount(tier: VeoQualityTier): number {
  return tier === "fast-720p" || tier === "fast-1080p" ? 2 : 3;
}

/** 把历史卡片里的 Veo 变体 id 收敛回 canonical "veo3.1", 真实 SKU 由 tier 控制. */
export function normalizeVeoModelToCanonical(modelId: string | undefined | null): string | null {
  if (!modelId) return null;
  if (!isVeoModel(modelId)) return modelId;
  return "veo3.1";
}

/**
 * Grok Video 时长档 — 每个 SKU 对应固定时长,UI 用胶囊选择。
 * 上游 PearNo 支持参考图(最多 7 张),比例 16:9/9:16/2:3/3:2/1:1,720P 固定。
 */
export type GrokDurationTier = "12s" | "16s" | "20s";

export const GROK_DURATION_TIERS: readonly { value: GrokDurationTier; label: string; price: string }[] = [
  { value: "12s", label: "12秒", price: "1.0" },
  { value: "16s", label: "16秒", price: "1.2" },
  { value: "20s", label: "20秒", price: "1.5" },
];

export function resolveGrokVariant(tier: GrokDurationTier): string {
  return `grok-video-${tier}`;
}

export function inferGrokTierFromLegacy(modelId: string | undefined | null): GrokDurationTier {
  if (!modelId) return "12s";
  if (modelId.includes("20s")) return "20s";
  if (modelId.includes("16s")) return "16s";
  return "12s";
}

/**
 * 从历史卡片的 (model SKU + 旧 resolution / veoFast 字段) 推断画质档。
 * 兼容所有历史格式: 旧 "4k" 别名、旧 resolution 字段值 ("fast"/"hd"/"pro"/"ref-720"/"ref-1080")、
 * 旧 veoFast boolean。
 */
export function inferVeoTierFromLegacy(
  modelId: string | undefined | null,
  legacyResolution?: string | undefined,
  legacyFast?: boolean,
): VeoQualityTier {
  const lr = (legacyResolution ?? "").toLowerCase();
  // 新 6 档原样
  if (lr === "fast-720p") return "fast-720p";
  if (lr === "std-720p") return "std-720p";
  if (lr === "pro-720p") return "pro-720p";
  if (lr === "fast-1080p") return "fast-1080p";
  if (lr === "std-1080p") return "std-1080p";
  if (lr === "pro-1080p") return "pro-1080p";
  // 老档位映射 — 参考模式不再编码在 tier, 收敛到画质 × 分辨率
  if (lr === "ref-1080" || lr === "ref-1080p") return "std-1080p";
  if (lr === "ref-720" || lr === "ref-720p") return "fast-720p";
  if (lr === "standard-1080p") return "std-1080p";
  if (lr === "pro") return "pro-1080p";
  if (lr === "hd" || lr === "4k") return legacyFast === false ? "pro-1080p" : "std-1080p";
  if (lr === "1080p") return legacyFast === false ? "pro-1080p" : "std-1080p";
  if (lr === "fast" || lr === "720p") return "fast-720p";

  if (!modelId) return "fast-720p";
  const m = modelId.toLowerCase();
  // 新 Cat 6 干净 SKU
  if (m === "veo3.1-pro-1080p") return "pro-1080p";
  if (m === "veo3.1-fast-1080p") return "fast-1080p";
  if (m === "veo3.1-1080p") return "std-1080p";
  if (m === "veo3.1-pro-720p") return "pro-720p";
  if (m === "veo3.1-fast-720p") return "fast-720p";
  if (m === "veo3.1-720p") return "std-720p";
  // 老 dbgoc SKU + V157 -cat SKU 收敛
  if (m === "veo3.1-pro-4k") return "pro-1080p";
  if (m === "veo3.1-4k") return "std-1080p";
  if (m === "veo3.1-fast") return "fast-720p";
  if (m === "veo3.1-pro-1080p-cat") return "pro-1080p";
  if (m === "veo3.1-fast-1080p-cat") return "fast-1080p";
  if (m === "veo3.1-1080p-cat") return "std-1080p";
  // 老 ref SKU 收敛(模式靠 imageMode 不在 tier)
  if (m === "veo3.1-ref-hd") return "std-1080p";
  if (m === "veo3.1-ref") return "fast-720p";
  if (m.includes("1080p") || m.includes("4k") || m.includes("-hd") || m.endsWith("hd")) return "std-1080p";
  return "fast-720p";
}


/**
 * 用 Volcano Seedance 协议构建提交请求体。
 * <p>
 * Seedance API 把 prompt / 图 / 音 / 视频统一塞进 {@code content[]} 数组，
 * 其余进度参数 (ratio / resolution / duration / generate_audio / camera_fixed / ...)
 * 平铺在 body 顶层。ComflyProvider.generateSeedanceVideo 和 SeedanceProvider.generateVideo
 * 用的是同一份字段集，因此抽到这里复用。
 *
 * @param model     上游模型名 (传给 body.model)。
 * @param req       canvas 侧的 VideoGenRequest。
 * @returns         拼好的 body, 可直接 POST。
 */
export function buildSeedanceBody(model: string, req: SeedanceBodyInput): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (req.prompt) {
    content.push({ type: "text", text: req.prompt });
  }
  if (req.referenceImages?.length) {
    for (const ref of req.referenceImages) {
      const role =
        ref.role === "firstFrame"
          ? "first_frame"
          : ref.role === "lastFrame"
            ? "last_frame"
            : "reference_image";
      content.push({ type: "image_url", image_url: { url: ref.url }, role });
    }
  }
  if (req.referenceAudios?.length) {
    for (const ref of req.referenceAudios) {
      content.push({ type: "audio_url", audio_url: { url: ref.url }, role: "reference_audio" });
    }
  }
  if (req.referenceVideos?.length) {
    for (const ref of req.referenceVideos) {
      content.push({ type: "video_url", video_url: { url: ref.url }, role: "reference_video" });
    }
  }

  const body: Record<string, unknown> = { model, content };
  const ratio = req.ratio ?? toSeedanceRatio(req.size);
  if (ratio) body.ratio = ratio;
  if (req.duration != null) body.duration = req.duration;
  if (req.frames != null) body.frames = req.frames;
  if (req.resolution) body.resolution = req.resolution;
  if (req.generateAudio != null) body.generate_audio = req.generateAudio;
  if (req.seed != null && req.seed !== -1) body.seed = req.seed;
  if (req.watermark != null) body.watermark = req.watermark;
  if (req.cameraFixed != null) body.camera_fixed = req.cameraFixed;
  if (req.returnLastFrame != null) body.return_last_frame = req.returnLastFrame;
  if (req.serviceTier) body.service_tier = req.serviceTier;
  if (req.executionExpiresAfter != null) body.execution_expires_after = req.executionExpiresAfter;
  if (req.draft != null) body.draft = req.draft;
  if (req.safetyIdentifier) body.safety_identifier = req.safetyIdentifier;
  if (req.tools?.length) body.tools = req.tools;
  if (req.callbackUrl) body.callback_url = req.callbackUrl;
  return body;
}

interface SeedanceBodyInput {
  prompt?: string;
  size?: string;
  ratio?: string;
  duration?: number;
  frames?: number;
  resolution?: string;
  generateAudio?: boolean;
  seed?: number;
  watermark?: boolean;
  cameraFixed?: boolean;
  returnLastFrame?: boolean;
  serviceTier?: "default" | "flex";
  executionExpiresAfter?: number;
  draft?: boolean;
  safetyIdentifier?: string;
  tools?: Array<{ type: string }>;
  callbackUrl?: string;
  referenceImages?: Array<{ url: string; role: string }>;
  referenceAudios?: Array<{ url: string; role: string }>;
  referenceVideos?: Array<{ url: string; role: string }>;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Translate the canvas's `size` value into the ratio string a Seedance
 * upstream API expects. Canvas uses "auto" for adaptive; Seedance wants
 * the literal string "adaptive".
 *
 * Returns `undefined` when the input is empty (caller should omit the
 * field — Seedance will use its own default which is `adaptive` on 2.0).
 */
export function toSeedanceRatio(size: string | undefined): string | undefined {
  if (!size) return undefined;
  if (size === "auto" || size === "adaptive") return "adaptive";
  if (size.includes(":")) return size;
  const m = size.match(/^(\d+)x(\d+)$/);
  if (!m) return size;
  const w = Number(m[1]);
  const h = Number(m[2]);
  const d = gcd(w, h);
  return `${w / d}:${h / d}`;
}

// ═══════════════════════════════════════════════════════════════════
// Seedance 2.0 VIP — 极境 Nexus 网关 (V138 重构 + V145 去 -15s 后缀)
// ═══════════════════════════════════════════════════════════════════
// 与旧 Seedance (Dale channel 1094, Volcano content[] 协议) 完全隔离.
// V145 后, 后端 5 个独立 model_name:
//   seedance-2-0-720p-no-person  (sd-2-vip, 720P, 不支持真人)
//   seedance-2-0-720p            (seedance-v2-720p, 720P, 支持真人)
//   seedance-2-0-720p-video      (720P + 视频参考)
//   seedance-2-0-1080p           (1080P, 支持真人)
//   seedance-2-0-1080p-video     (1080P + 视频参考)
// duration 后端支持 5-15 秒, 缺省 15. canvas 暂不暴露 duration 控件 → 始终走默认 15s.
// quality 字段废弃.
//
// canvas UI 把 5 个上游收敛成 2 个下拉项:
//   - alias `seedance-2-0`: 内部按 (分辨率, 是否传视频) resolve 到 4 个主上游
//   - economy `seedance-2-0-720p-no-person`: 单独项 (因为不支持真人)
// ═══════════════════════════════════════════════════════════════════

/** alias 项 (覆盖 4 个主上游): 用户在 UI 选分辨率, 提交时按是否有视频参考 resolve. */
export const SEEDANCE_VIP_ALIAS_ID = "seedance-2-0";

/** economy 项: 独立 model_name, 不进 alias resolve. */
export const SEEDANCE_VIP_ECONOMY_ID = "seedance-2-0-720p-no-person";

/** 4 个主上游 model_name (alias resolve 的目标值域). */
const SEEDANCE_VIP_ALIAS_TARGETS = new Set<string>([
  "seedance-2-0-720p",
  "seedance-2-0-720p-video",
  "seedance-2-0-1080p",
  "seedance-2-0-1080p-video",
]);

/**
 * VIP 系列模型判定 — alias + economy + 4 个主上游全部识别.
 * 旧 `seedance-2-0-vip` 字符串不再识别; 老卡片若残留该 model id 会走 combo
 * 默认 fallback 路径 (ModelSelector 不在 list 中即重置), 不在此处特殊映射.
 */
const SEEDANCE_VIP_MODEL_IDS = new Set<string>([
  SEEDANCE_VIP_ALIAS_ID,
  SEEDANCE_VIP_ECONOMY_ID,
  ...SEEDANCE_VIP_ALIAS_TARGETS,
]);

export function isSeedanceVipModel(modelId: string | undefined | null): boolean {
  if (!modelId) return false;
  return SEEDANCE_VIP_MODEL_IDS.has(modelId);
}

/** alias 项判定 (区别于 economy / 主上游). 用于 UI 是否渲染分辨率胶囊 + 视频插槽. */
export function isSeedanceVipAliasModel(modelId: string | undefined | null): boolean {
  return modelId === SEEDANCE_VIP_ALIAS_ID;
}

/** economy 项判定. UI 不渲染分辨率胶囊, 不暴露视频插槽. */
export function isSeedanceVipEconomyModel(modelId: string | undefined | null): boolean {
  return modelId === SEEDANCE_VIP_ECONOMY_ID;
}

/** 分辨率档 — 仅 alias 项暴露 (economy 固定 720P). */
export type SeedanceVipResolution = "720p" | "1080p";

/** 分辨率选项, 给 SizeCombo.resolutionOptions 槽位用 (复用 Veo/Seedance 的胶囊位). */
export const SEEDANCE_VIP_RESOLUTION_TIERS: readonly { value: SeedanceVipResolution; label: string }[] = [
  { value: "720p",  label: "720P" },
  { value: "1080p", label: "1080P" },
];

/**
 * V138/V145 核心 resolve: alias `seedance-2-0` 提交时按 (分辨率, 是否传视频) 选具体上游.
 *   720P + 无视频 → seedance-2-0-720p            (¥12, 支持真人)
 *   720P + 有视频 → seedance-2-0-720p-video      (¥15, 支持视频参考)
 *   1080P + 无视频 → seedance-2-0-1080p          (¥26, 支持真人)
 *   1080P + 有视频 → seedance-2-0-1080p-video    (¥32, 支持视频参考)
 */
export function resolveSeedanceVipModelId(
  resolution: SeedanceVipResolution,
  hasVideos: boolean,
): string {
  if (resolution === "1080p") {
    return hasVideos ? "seedance-2-0-1080p-video" : "seedance-2-0-1080p";
  }
  return hasVideos ? "seedance-2-0-720p-video" : "seedance-2-0-720p";
}

/**
 * 把 (分辨率, ratio) 翻译成后端 form_schema 期望的具体像素 size 字符串.
 *   720P + 16:9 → "1280x720"
 *   720P + 9:16 → "720x1280"
 *   1080P + 16:9 → "1920x1080"
 *   1080P + 9:16 → "1080x1920"
 * 后端 NexusVideoAdapter.resolveSize 在 size 缺省时只能推断 720P 比例,
 * 1080P 必须前端显式发具体像素值, 故所有 VIP 提交都走这个 helper.
 */
export function resolveSeedanceVipSize(
  resolution: SeedanceVipResolution,
  ratio: string,
): string {
  const is1080 = resolution === "1080p";
  const isPortrait = ratio === "9:16" || ratio === "720x1280" || ratio === "1080x1920";
  if (isPortrait) return is1080 ? "1080x1920" : "720x1280";
  return is1080 ? "1920x1080" : "1280x720";
}


/**
 * Veo doesn't support `adaptive`, so canvas "auto" is dropped (caller
 * should omit aspect_ratio and let the upstream default kick in).
 */
export function toVeoAspectRatio(size: string | undefined): string | undefined {
  if (!size || size === "auto" || size === "adaptive") return undefined;
  if (size.includes(":")) return size;
  const m = size.match(/^(\d+)x(\d+)$/);
  if (!m) return undefined;
  const w = Number(m[1]);
  const h = Number(m[2]);
  const d = gcd(w, h);
  return `${w / d}:${h / d}`;
}


// ═════════════════════════════════════════════════════════════════════
// V161 火山方舟原生 Seedance 2.0 聚合 alias
// ─────────────────────────────────────────────────────────────────────
// 跟 V145 Nexus 系列 (`isSeedanceVipModel` + `seedance-2-0` alias) 完全分开:
// 服务端 V161 接的是火山方舟官方 ark.cn-beijing.volces.com 直连,
// 计费走 PER_TOKEN_PREPAID (按 token × 单价多退少补), 而 V145 是 Nexus 平台
// 按次定价 (PER_REQUEST). 两条路径上游 / 协议 / 计费维度都不同, 不混用.
//
// 服务端注册 4 个独立 model_route:
//   seedance-2-0                 标准 + 无视频参考 (上游 doubao-seedance-2-0-260128,      上游 46/M, 售价 51/M, 预扣 20)
//   seedance-2-0-fast            fast + 无视频参考 (上游 doubao-seedance-2-0-fast-260128, 上游 37/M, 售价 41/M, 预扣 20)
//   seedance-2-0-video-ref       标准 + 含视频参考                                         (上游 28/M, 售价 31/M, 预扣 40)
//   seedance-2-0-fast-video-ref  fast + 含视频参考                                         (上游 22/M, 售价 25/M, 预扣 40)
//
// 火山真实计费维度只有"是否含视频参考"; 纯文本 + 图片参考 同算 no_video 档.
// version (standard/fast/mini) 是画质 / 速度档, 影响 token 单价; 预扣按 (model × resolution).
// ═════════════════════════════════════════════════════════════════════

/** 画质 / 速度档 (用户在 UI 上选, 不影响预扣金额). mini = 火山最低价档 (V163 新增). */
export type SeedanceV2Version = "standard" | "fast" | "mini";

/** UI button-group 选项 — VideoEditor 通过此数组渲染版本切换胶囊.
 *  label 用火山官方档名 (mini / fast / standard), 按"便宜→好"排序;
 *  不重复 "Seedance 2.0" 字样 (model 名已在 ModelSelector 显示). */
export const SEEDANCE_V2_VERSION_TIERS: readonly { value: SeedanceV2Version; label: string }[] = [
  { value: "mini",     label: "mini" },
  { value: "fast",     label: "fast" },
  { value: "standard", label: "standard" },
];

/** 聚合 alias model id (UI 显示这一项, 提交时按 resolve 函数转成 4 个具体 model). */
export const SEEDANCE_V2_ALIAS_ID = "seedance-v2";

const SEEDANCE_V2_MODEL_IDS = new Set<string>([
  SEEDANCE_V2_ALIAS_ID,
  "seedance-2-0",
  "seedance-2-0-fast",
  "seedance-2-0-video-ref",
  "seedance-2-0-fast-video-ref",
  // V163 mini 档 (后端 route 2247/2248, 上游 doubao-seedance-2-0-mini-260615).
  "seedance-2-0-mini",
  "seedance-2-0-mini-video-ref",
]);

/** 整个 V161 火山方舟体系 (alias + 4 个具体 model) 的判定. */
export function isSeedanceV2Model(modelId: string | undefined | null): boolean {
  if (!modelId) return false;
  return SEEDANCE_V2_MODEL_IDS.has(modelId);
}

/** 仅 alias 项判定 (用于 UI 是否渲染 version 切换胶囊). */
export function isSeedanceV2AliasModel(modelId: string | undefined | null): boolean {
  return modelId === SEEDANCE_V2_ALIAS_ID;
}

/**
 * V161 火山方舟原生 Seedance 2.0 聚合 — 按 (version × 是否传视频参考) 选 4 个具体 model.
 *
 * 计费提示 (上游单价 元/百万 token, V163):
 *   standard + no_video   → seedance-2-0                  上游 46 / 预扣按分辨率
 *   fast     + no_video   → seedance-2-0-fast             上游 37 / 预扣按分辨率
 *   mini     + no_video   → seedance-2-0-mini             上游 23 / 预扣按分辨率
 *   standard + with_video → seedance-2-0-video-ref        上游 28
 *   fast     + with_video → seedance-2-0-fast-video-ref   上游 22
 *   mini     + with_video → seedance-2-0-mini-video-ref   上游 14
 *
 * 火山按 token 计费, 提交时按 (model × resolution × hasVideos) 预扣, 完成后按上游
 * usage.completion_tokens × 单价多退少补.
 *
 * 注意: 纯文本 + 图片参考 同算 no_video 档 (火山只看 content 数组里是否有
 * video_url 类型). 只有 referenceVideos 非空才走 with_video.
 */
export function resolveSeedanceV2ModelId(
  version: SeedanceV2Version,
  hasVideos: boolean,
): string {
  if (hasVideos) {
    if (version === "fast") return "seedance-2-0-fast-video-ref";
    if (version === "mini") return "seedance-2-0-mini-video-ref";
    return "seedance-2-0-video-ref";
  }
  if (version === "fast") return "seedance-2-0-fast";
  if (version === "mini") return "seedance-2-0-mini";
  return "seedance-2-0";
}

/**
 * 火山原生 Seedance 2.0 分辨率档 (V163)。官方 doubao-seedance-2-0(standard) 支持
 * 480p/720p/1080p/4k; fast 与 mini 上游不支持 1080p/4k, 只放 480p/720p
 * (见 {@link isSeedanceV2ResolutionAllowed})。
 *
 * 注意: resolution 是独立的 body 字段,不编码在 model 名里 —— 还是那 6 个 model
 * (standard/fast/mini × 有无视频参考),resolution 单独透传给火山, 后端
 * VolcanoArkVideoAdapter 原样转发。计费按 token 实结,后端按 (model × resolution × hasVideo)
 * 查单价 (standard 的 per-token 单价随分辨率变: 720p=46 / 1080p=51 / 4k=26, 4k 反而最低
 * 因 token 量大), 前端不配价、只透传分辨率。
 */
export type SeedanceV2Resolution = "480p" | "720p" | "1080p" | "4k";

export const SEEDANCE_V2_RESOLUTION_TIERS: readonly { value: SeedanceV2Resolution; label: string }[] = [
  { value: "480p",  label: "480P" },
  { value: "720p",  label: "720P" },
  { value: "1080p", label: "1080P" },
  { value: "4k",    label: "4K" },
];

/** 1080p/4k 仅 standard 支持; fast/mini 上限 720p — 判某分辨率在当前 version 下是否可选
 *  (UI 置灰 + 提交前钳制都用它)。 */
export function isSeedanceV2ResolutionAllowed(
  version: SeedanceV2Version,
  resolution: SeedanceV2Resolution,
): boolean {
  if (resolution === "1080p" || resolution === "4k") return version === "standard";
  return true; // 480p / 720p 所有档都支持
}

/** 把(version, 期望分辨率)钳到合法值: 非 standard 选了 1080p/4k → 720p,其余原样。 */
export function clampSeedanceV2Resolution(
  version: SeedanceV2Version,
  resolution: SeedanceV2Resolution,
): SeedanceV2Resolution {
  return isSeedanceV2ResolutionAllowed(version, resolution) ? resolution : "720p";
}


// ═════════════════════════════════════════════════════════════════════
// Omni (Veo Omni Flash) — 极境网关 (JiJing V188, channel 1099 / DSF 甜甜圈)
// ─────────────────────────────────────────────────────────────────────
// canvas 下拉里只有一个 `omni` 项,提交时按"是否连了源视频"分流到两个后端 model:
//   omni        文生 / 首尾帧 (i2v) / 参考图 (r2v)  —— 固定 10s
//   omni-edit   1 段源视频 + 可选参考图 → 重绘      —— 固定 10s
// 跟 seedance-v2 的 (version × hasVideos) 四路分发同构,这里只有 hasVideos 一维。
//
// 协议要点 (后端 DsfOmniVideoAdapter 兜底,canvas 只发网关参数):
//   - aspect_ratio 仅 16:9 / 9:16
//   - 不发 duration (后端强制 10s) / generate_audio / resolution
//   - i2v 与 r2v 都走单一 images 字段,靠 video_type 区分 (不像 Veo 拆 images/referenceImages)
//   - omni i2v 上游只吃首 + 尾 2 帧;r2v 参考图 ≤7 张
// ═════════════════════════════════════════════════════════════════════

/** canvas 下拉里唯一的 omni 项 id (生成态)。 */
export const OMNI_ALIAS_ID = "omni";

/** 连了源视频后提交时分流到的视频编辑 model id。 */
export const OMNI_EDIT_ID = "omni-edit";

/** 整个 omni 体系 (生成 + 编辑) 判定。 */
export function isOmniModel(modelId: string | undefined | null): boolean {
  return modelId === OMNI_ALIAS_ID || modelId === OMNI_EDIT_ID;
}

/** 仅编辑态判定 (provider 据此决定走 videos 还是 video_type 分支)。 */
export function isOmniEditModel(modelId: string | undefined | null): boolean {
  return modelId === OMNI_EDIT_ID;
}

/**
 * 视频模型是否支持「参考」模式 (reference / r2v)。
 *
 * **单一真相**:VideoEditor 的 `availableModes`(是否渲染「参考」胶囊)与 dataFlow 的
 * 「首尾帧满 2 帧后自动切参考」逻辑都从这里取,口径必须一致、禁止各写一份布尔表达式,
 * 否则会出现「UI 能切但连线被拒」或反之的漂移。
 *
 * 不支持的(基础 i2v 模型)只有首尾帧模式,最多 2 张图(首帧 + 尾帧)。
 */
export function videoSupportsReferenceMode(modelId: string | undefined | null): boolean {
  return (
    isSeedanceModel(modelId) ||
    isVeoModel(modelId) ||
    isGrokVideoModel(modelId) ||
    isSeedanceVipModel(modelId) ||
    isSeedanceV2AliasModel(modelId) ||
    isOmniModel(modelId)
  );
}

/**
 * omni 提交分流:连了源视频 → omni-edit (视频编辑),否则 → omni (生成)。
 * 与 {@link resolveSeedanceV2ModelId} 同构,只有 hasVideos 一维。
 */
export function resolveOmniModelId(hasVideos: boolean): string {
  return hasVideos ? OMNI_EDIT_ID : OMNI_ALIAS_ID;
}

/**
 * 由 imageMode + 参考图数量派生 omni 的 video_type (仅生成态用,编辑态不发)。
 *   0 图           → t2v (纯文生)
 *   firstLastFrame → i2v (首尾帧,上游吃首 + 尾 2 帧)
 *   reference      → r2v (参考图,≤7 张)
 *
 * imageMode 用内联字面量联合而非 import VideoImageMode —— config/model-ref-images
 * 反过来 import 本模块,避免循环依赖。
 */
export function deriveOmniVideoType(
  imageMode: "firstLastFrame" | "reference",
  imageCount: number,
): "t2v" | "i2v" | "r2v" {
  if (imageCount === 0) return "t2v";
  return imageMode === "firstLastFrame" ? "i2v" : "r2v";
}

/**
 * omni 仅支持 16:9 / 9:16。复用 {@link toVeoAspectRatio} 的比例换算,非这两档兜底 16:9。
 * (UI 层 getAllowedVideoSizesForModel 已把可选项锁到这两档,这里是出站再防一道。)
 */
export function toOmniAspectRatio(size: string | undefined): string {
  const aspect = toVeoAspectRatio(size);
  return aspect === "16:9" || aspect === "9:16" ? aspect : "16:9";
}
