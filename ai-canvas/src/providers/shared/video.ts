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

export function isVideoGenModel(modelId: string | undefined | null): boolean {
  return isSeedanceModel(modelId) || isVeoModel(modelId);
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
