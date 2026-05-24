import type {
  AIProvider,
  ProviderDescriptor,
  ChatRequest,
  ChatResponse,
  StreamEvent,
  ImageGenRequest,
  ImageGenResponse,
  VideoGenRequest,
  VideoGenResponse,
} from "../types";
import { throwIfError } from "../errors";
import {
  formatMessagesForOpenAI,
  parseOpenAIChatResponse,
  parseOpenAIStreamChunk,
  resetStreamState,
  getAccumulatedToolCalls,
  getLastFinishReason,
} from "./formatter";
import { aiProxy, aiProxyStream, isTauri, listModels as platformListModels } from "@/platform";
import { mediaToApiRef } from "@/platform/media";
import { executeAsyncMediaTask } from "../shared/asyncMediaTask";
import { PROGRESS_EXPECTED_SEC } from "../shared/progress";
import { normalizeResolution } from "@/shared/constants";
import type { ModelInfo } from "@/types";

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function toAspectRatio(size: string): string {
  if (size.includes(":")) return size;
  const m = size.match(/^(\d+)x(\d+)$/);
  if (!m) return size;
  const w = Number(m[1]);
  const h = Number(m[2]);
  const d = gcd(w, h);
  return `${w / d}:${h / d}`;
}

// gpt-image-2 后端约束: 单边 832-3840、整除 16、比例 ≤ 3:1、总像素 ≤ 8.29MP
// 每条尺寸均经过约束校验，比例误差 0%
const GPT_IMAGE_2_SIZE_MAP: Record<string, Record<string, string>> = {
  "2K": {
    "1:1": "2048x2048",
    "3:2": "1920x1280",
    "2:3": "1280x1920",
    "4:3": "2048x1536",
    "3:4": "1536x2048",
    "16:9": "2560x1440",
    "9:16": "1440x2560",
  },
  "4K": {
    "1:1": "2880x2880",
    "3:2": "3072x2048",
    "2:3": "2048x3072",
    "4:3": "3072x2304",
    "3:4": "2304x3072",
    "16:9": "3840x2160",
    "9:16": "2160x3840",
  },
};

function toGptImage2Size(size: string, resolution: string): string | undefined {
  const ratio = toAspectRatio(size);
  return GPT_IMAGE_2_SIZE_MAP[resolution]?.[ratio];
}

function makeRequestId(): string {
  return globalThis.crypto?.randomUUID?.().slice(0, 8)
    ?? Math.random().toString(36).slice(2, 10);
}

/**
 * Base class for providers using the OpenAI-compatible API protocol.
 * Subclasses only need to provide `descriptor` and optionally override
 * `staticModels()` or individual generation methods.
 */
export abstract class OpenAICompatProvider implements AIProvider {
  abstract readonly descriptor: ProviderDescriptor;

  protected get providerId(): string {
    return this.descriptor.id;
  }

  protected staticModels(): ModelInfo[] {
    return [];
  }

  protected defaultImageModel(): string {
    return "gpt-image-1.5";
  }

  protected defaultVideoModel(): string {
    return "veo3.1";
  }

  protected imageRefField(): string {
    return "image";
  }

  protected videoEndpoint(): string {
    return "/v2/videos/generations";
  }

  resolveImageModelId(baseId: string, _resolution: string, _quality?: string): string {
    return baseId;
  }

  getDisplayName(modelId: string): string | undefined {
    const m = this.staticModels().find((m) => m.id === modelId);
    return m ? (m.display_name ?? m.id) : undefined;
  }

  listModelsSync(): ModelInfo[] {
    return this.staticModels();
  }

  async listModels(): Promise<ModelInfo[]> {
    const statics = this.staticModels();
    if (statics.length > 0) return statics;

    try {
      const raw = await platformListModels(this.providerId);
      return raw.map((m) => ({
        id: m.id,
        display_name: m.display_name ?? m.id,
        capability: m.capability ?? "CHAT",
      }));
    } catch {
      return [];
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const messages = formatMessagesForOpenAI(req);
    const body: Record<string, unknown> = { model: req.model, messages };
    if (req.tools?.length) body.tools = req.tools;
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.temperature != null) body.temperature = req.temperature;

    const raw = await aiProxy(this.providerId, "/v1/chat/completions", body);
    throwIfError(raw.status, raw.body);
    return parseOpenAIChatResponse(raw);
  }

  async streamChat(
    req: ChatRequest,
    onEvent: (event: StreamEvent) => void,
  ): Promise<{ abort: () => void }> {
    resetStreamState();

    const messages = formatMessagesForOpenAI(req);
    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      stream: true,
    };
    if (req.tools?.length) body.tools = req.tools;
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.temperature != null) body.temperature = req.temperature;

    const { abort } = await aiProxyStream(
      this.providerId,
      "/v1/chat/completions",
      body,
      {
        onChunk: (raw) => parseOpenAIStreamChunk(raw, onEvent),
        onDone: () => {
          const tcs = getAccumulatedToolCalls();
          for (const tc of tcs) {
            onEvent({ type: "tool_call_end", id: tc.id });
          }
          const fr = getLastFinishReason();
          const finishReason =
            fr === "tool_calls" || fr === "function_call"
              ? "tool_calls" as const
              : fr === "length"
                ? "length" as const
                : "stop" as const;
          onEvent({ type: "done", finishReason });
        },
        onError: (e) => onEvent({ type: "error", message: e }),
      },
    );

    if (req.signal) {
      const forwardAbort = () => {
        void abort();
      };
      if (req.signal.aborted) forwardAbort();
      else req.signal.addEventListener("abort", forwardAbort, { once: true });
    }

    return { abort };
  }

  async generateImage(req: ImageGenRequest): Promise<ImageGenResponse> {
    const imageField = this.imageRefField();
    const requestId = makeRequestId();
    const baseModelId = req.model ?? this.defaultImageModel();
    const baseModelLower = baseModelId.toLowerCase();
    const isGptImage2 = baseModelLower.startsWith("gpt-image-2") || baseModelLower.startsWith("gpt-image-1");
    // 调用方(chat / agent 工具调用 / 卡片编辑器)可能传:裸 baseId ("gpt-image-2"/"nano-banana-2")、
    // 已 resolved 的 sku ("gpt-image-2-2k")、或不传 model。JiJing 后端 ModelRouter 没有裸路由,
    // 只认精确 sku。这里把 resolution 收敛到 "2K"/"4K"(缺省 2K),再走 provider 的 id 映射。
    // resolveImageModelId 对已 resolved 的 sku 幂等返回,所以 MediaEditor 已 resolve 的路径也安全。
    const resolution = normalizeResolution(req.resolution);
    const modelId = this.resolveImageModelId(baseModelId, resolution, req.quality);

    const body: Record<string, unknown> = {
      model: modelId,
      n: 1,
      response_format: "url",
    };
    if (isTauri) body._debug_request_id = requestId;

    if (req.prompt) {
      body.prompt = req.prompt;
      const baseSize = req.size || "1024x1024";
      const pixelSize = isGptImage2 ? toGptImage2Size(baseSize, resolution) : undefined;
      body.size = pixelSize ?? toAspectRatio(baseSize);
      // gpt-image-* 只接受 low/medium/high/auto；DALL-E 用 standard/hd。映射兜底。
      if (isGptImage2) {
        const q = (req.quality || "medium").toLowerCase();
        const map: Record<string, string> = { standard: "medium", hd: "high" };
        body.quality = map[q] ?? (["low", "medium", "high", "auto"].includes(q) ? q : "medium");
      } else {
        body.quality = req.quality || "standard";
      }
    }

    if (req.referenceImages?.length) {
      // 所有 ref 图统一走 mediaToApiRef → /v1/files/upload 拿 HTTP URL。
      // 之前用 compressDataUrlForApi 是死代码 (Tauri 下 ref.url 是 local://
      // 占位符, 不满足 startsWith("data:") 立刻 return 原样, 等于完全没压),
      // 而且即便压了也是 base64 inline 仍然会撞 ipc_guard 64MB。
      // 详见 docs/media-upload-refactor.md。
      body[imageField] = await Promise.all(
        req.referenceImages.map((ref) => mediaToApiRef(ref.url)),
      );
    }

    const isHd = req.resolution === "2K" || req.resolution === "4K";
    return await executeAsyncMediaTask({
      providerId: this.providerId,
      submitEndpoint: "/v1/images/generations",
      body,
      emit: req.onProgress,
      expectedSec: isHd ? PROGRESS_EXPECTED_SEC.imageHD : PROGRESS_EXPECTED_SEC.image,
      generatingLabel: "生成中…",
      submittingLabel: "正在提交请求…",
      savingLabel: "正在保存图片…",
      failedFallbackMessage: "图片生成失败",
      projectId: req.projectId,
      title: req.prompt,
      cardId: req.cardId,
      kind: "image_gen",
      trySyncResult: (data) => {
        // OpenAI 兼容图像 API 经常一次性返回 URL (data[0].url + revised_prompt)
        const d = data as { data?: Array<{ url?: string; revised_prompt?: string }> };
        const img = d.data?.[0];
        if (img?.url) {
          return { url: img.url, revisedPrompt: img.revised_prompt };
        }
        return null;
      },
    });
  }

  async generateVideo(req: VideoGenRequest): Promise<VideoGenResponse> {
    const body: Record<string, unknown> = {
      prompt: req.prompt,
      model: req.model ?? this.defaultVideoModel(),
    };
    if (req.referenceImages?.length) {
      body.images = await Promise.all(
        req.referenceImages.map((ref) => mediaToApiRef(ref.url)),
      );
    }
    if (req.size && req.size !== "auto") {
      body.aspect_ratio = toAspectRatio(req.size);
    }

    return await executeAsyncMediaTask({
      providerId: this.providerId,
      submitEndpoint: this.videoEndpoint(),
      body,
      emit: req.onProgress,
      expectedSec: PROGRESS_EXPECTED_SEC.videoGeneric,
      generatingLabel: "视频生成中…",
      submittingLabel: "正在提交视频请求…",
      savingLabel: "正在保存视频…",
      failedFallbackMessage: "视频生成失败",
      projectId: req.projectId,
      title: req.prompt,
      cardId: req.cardId,
      kind: "video_gen",
    });
  }
}
