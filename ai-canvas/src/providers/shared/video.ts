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

/**
 * Veo "参考图" (image-asset) 子家族。上游 dbgoc 硬约束: 16:9 + 8s + 1-3 张参考图。
 * 与首帧/首尾帧的 frame 模式走不同 pipeline，必须用 veo31-ref / veo31-ref-HD 上游。
 */
export function isVeoRefModel(modelId: string | undefined | null): boolean {
  if (!modelId) return false;
  return modelId === "veo3.1-ref" || modelId === "veo3.1-ref-hd";
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

export function resolveVeoUpstreamModel(modelId: string | undefined): string {
  if (!modelId || modelId === "veo3.1") return "veo3.1-fast";
  return modelId;
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
 * Veo 3.1 画质档 — UI 胶囊选择器直接对应的值。
 *
 * 非参考模式 3 档:
 *   "fast-720p"       → veo3.1-fast      (upstream veo31-fast,    $0.20, ~20-60s)
 *   "standard-1080p"  → veo3.1-1080p     (upstream veo31-fast-HD, $0.30, ~60-150s)
 *   "pro-1080p"       → veo3.1-pro-1080p (upstream veo31-HD,      $0.35, ~80-240s)
 *
 * 参考模式 2 档 (fast 引擎不支持 image-asset):
 *   "ref-720p"        → veo3.1-ref       (upstream veo31-ref,    $0.30)
 *   "ref-1080p"       → veo3.1-ref-hd    (upstream veo31-ref-HD, $0.35)
 */
export type VeoQualityTier = "fast-720p" | "standard-1080p" | "pro-1080p" | "ref-720p" | "ref-1080p";

export const VEO_NON_REF_TIERS: readonly { value: VeoQualityTier; label: string; price: string }[] = [
  { value: "fast-720p",      label: "快速 720P",  price: "0.5" },
  { value: "standard-1080p", label: "标准 1080P", price: "1.0" },
  { value: "pro-1080p",      label: "Pro 1080P",  price: "1.5" },
];

export const VEO_REF_TIERS: readonly { value: VeoQualityTier; label: string; price: string }[] = [
  { value: "ref-720p",  label: "720P",  price: "1.0" },
  { value: "ref-1080p", label: "1080P", price: "1.5" },
];

export function resolveVeoVariantForMode(
  mode: "text" | "firstFrame" | "firstLastFrame" | "reference",
  tier: VeoQualityTier,
): string {
  if (mode === "reference") {
    return tier === "ref-720p" ? "veo3.1-ref" : "veo3.1-ref-hd";
  }
  switch (tier) {
    case "fast-720p": return "veo3.1-fast";
    case "standard-1080p": return "veo3.1-1080p";
    case "pro-1080p": return "veo3.1-pro-1080p";
    default: return "veo3.1-fast";
  }
}

/** 把历史卡片里的 Veo 变体 id 收敛回 canonical "veo3.1"，给收紧后的 dropdown 用。 */
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
  if (lr === "ref-1080") return "ref-1080p";
  if (lr === "ref-720") return "ref-720p";
  if (lr === "pro") return "pro-1080p";
  if (lr === "hd" || lr === "4k") return legacyFast === false ? "pro-1080p" : "standard-1080p";
  if (lr === "1080p") return legacyFast === false ? "pro-1080p" : "standard-1080p";
  if (lr === "fast" || lr === "720p") return "fast-720p";

  if (!modelId) return "fast-720p";
  const m = modelId.toLowerCase();
  if (m === "veo3.1-pro-1080p" || m === "veo3.1-pro-4k") return "pro-1080p";
  if (m === "veo3.1-1080p" || m === "veo3.1-4k") return "standard-1080p";
  if (m === "veo3.1-ref-hd") return "ref-1080p";
  if (m === "veo3.1-ref") return "ref-720p";
  if (m.includes("1080p") || m.includes("4k") || m.includes("-hd") || m.endsWith("hd")) return "standard-1080p";
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
// Seedance 2.0 VIP — 极境 Nexus 网关 (V138 重构)
// ═══════════════════════════════════════════════════════════════════
// 与旧 Seedance (Dale channel 1094, Volcano content[] 协议) 完全隔离.
// V138 把后端 route 拆成 5 个独立 model_name:
//   seedance-2-0-720p-15s-no-person  (sd-2-vip, 720P, 不支持真人)
//   seedance-2-0-720p-15s            (Seedance2.0-720P-15S, 720P, 支持真人)
//   seedance-2-0-720p-video          (720P + 视频参考)
//   seedance-2-0-1080p               (1080P, 支持真人)
//   seedance-2-0-1080p-video         (1080P + 视频参考)
// duration 后端固定 15 秒 (form 不暴露), quality 字段废弃.
//
// canvas UI 把 5 个上游收敛成 2 个下拉项:
//   - alias `seedance-2-0`: 内部按 (分辨率, 是否传视频) resolve 到 4 个主上游
//   - economy `seedance-2-0-720p-15s-no-person`: 单独项 (因为不支持真人)
// ═══════════════════════════════════════════════════════════════════

/** alias 项 (覆盖 4 个主上游): 用户在 UI 选分辨率, 提交时按是否有视频参考 resolve. */
export const SEEDANCE_VIP_ALIAS_ID = "seedance-2-0";

/** economy 项: 独立 model_name, 不进 alias resolve. */
export const SEEDANCE_VIP_ECONOMY_ID = "seedance-2-0-720p-15s-no-person";

/** 4 个主上游 model_name (alias resolve 的目标值域). */
const SEEDANCE_VIP_ALIAS_TARGETS = new Set<string>([
  "seedance-2-0-720p-15s",
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
 * V138 核心 resolve: alias `seedance-2-0` 提交时按 (分辨率, 是否传视频) 选具体上游.
 *   720P + 无视频 → seedance-2-0-720p-15s        (¥12, 支持真人)
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
  return hasVideos ? "seedance-2-0-720p-video" : "seedance-2-0-720p-15s";
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
