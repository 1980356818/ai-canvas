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
import { uploadMediaBatch } from "@/platform/media";
import { executeAsyncMediaTask } from "../shared/asyncMediaTask";
import { MODEL_FALLBACKS_FIELD } from "../shared/modelFallback";
import { PROGRESS_EXPECTED_SEC } from "../shared/progress";
import { normalizeResolution } from "@/shared/constants";
import { diagInfo } from "@/lib/diag";
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
// 1K 档:长边压到 ~1024-1536,短边受 832 下限托底 (÷16、比例精确),像素量约为 2K 的 1/3~1/4。
const GPT_IMAGE_2_SIZE_MAP: Record<string, Record<string, string>> = {
  "1K": {
    "1:1": "1024x1024",
    "3:2": "1248x832",
    "2:3": "832x1248",
    "4:3": "1152x864",
    "3:4": "864x1152",
    "16:9": "1536x864",
    "9:16": "864x1536",
  },
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

// 极境分档 SKU 被关停时,网关提交会报「模型[xxx]未配置路由」。给会被关的档位挂一条
// 静默降级候选(同画质、低一档分辨率):提交层(mediaHandler / asyncMediaTask)遇到
// 路由未配置时自动改用,任务不进 failed、不弹提示。
// 范围刻意最小 —— 只覆盖 medium-2K→1K(用户决策);需要扩展(high / 4K 链)按此格式加条目即可。
const GPT_IMAGE_2_ROUTE_FALLBACK: Record<string, { model: string; resolution: string }> = {
  "gpt-image-2-medium-2k": { model: "gpt-image-2-medium-1k", resolution: "1K" },
};

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

    // 诊断:确认出参里是否误带 image_url(纯文本模型如极境 gpt-5.5 收到图会回「请求参数有误」)。
    const _msgsJson = JSON.stringify(messages);
    diagInfo("ai-stream-raw", "⑤b 出参请求体", {
      model: req.model,
      maxTokens: req.maxTokens,
      hasImageUrl: _msgsJson.includes("image_url"),
      bodyBytes: JSON.stringify(body).length,
      messagesPreview: _msgsJson.slice(0, 600),
    });

    // 诊断:后端(Rust do_stream)到底 emit 了几条 raw `data:` chunk、第一条长啥样。
    // 用来区分「后端一条都没发(app 的 reqwest 拿到空 body)」vs「发了但是 error 对象
    // 被 parseOpenAIStreamChunk 静默丢弃(只认 choices[0].delta)」两种空回复成因。
    let _rawChunkCount = 0;
    let _rawSample = "";
    const { abort } = await aiProxyStream(
      this.providerId,
      "/v1/chat/completions",
      body,
      {
        onChunk: (raw) => {
          _rawChunkCount += 1;
          if (_rawChunkCount <= 3) _rawSample += `[${_rawChunkCount}] ${raw.slice(0, 240)}\n`;
          parseOpenAIStreamChunk(raw, onEvent);
        },
        onDone: () => {
          diagInfo("ai-stream-raw", "⑦b 后端 chunk 流结束(rawChunkCount=0 即后端没收到任何 data 行)", {
            model: req.model,
            provider: this.providerId,
            rawChunkCount: _rawChunkCount,
            sample: _rawSample.slice(0, 720) || "(无任何 chunk)",
          });
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

    // 极境分档模型被关停(网关「未配置路由」)→ 给可降级的档位挂静默降级候选,
    // 提交层遇到路由未配置时自动改用(详见 GPT_IMAGE_2_ROUTE_FALLBACK)。
    const routeFallback = isGptImage2 ? GPT_IMAGE_2_ROUTE_FALLBACK[modelId] : undefined;
    if (routeFallback && req.prompt) {
      const fbSize = toGptImage2Size(req.size || "1024x1024", routeFallback.resolution);
      body[MODEL_FALLBACKS_FIELD] = [
        { model: routeFallback.model, ...(fbSize ? { size: fbSize } : {}) },
      ];
    }

    if (req.referenceImages?.length) {
      // 所有 ref 图统一走 uploadMediaBatch → /v1/files/upload 拿 HTTP URL。
      // 详见 docs/media-upload-refactor.md。
      //
      // 借用 GenerationProgress 的 "submitting" phase 反馈上传阶段,
      // UI 看到 "上传媒体 2/3…" 而非 "准备中…",根治用户感受的 "卡住"。
      // 真正提交请求后 executeAsyncMediaTask 会立刻把 label 覆盖为 submittingLabel。
      body[imageField] = await uploadMediaBatch(
        req.referenceImages.map((ref) => ref.url),
        {
          onProgress: ({ uploaded, total }) => {
            req.onProgress?.({
              percent: 0,
              phase: "submitting",
              label: `上传媒体 ${uploaded}/${total}…`,
            });
          },
        },
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
      body.images = await uploadMediaBatch(
        req.referenceImages.map((ref) => ref.url),
        {
          onProgress: ({ uploaded, total }) => {
            req.onProgress?.({
              percent: 0,
              phase: "submitting",
              label: `上传媒体 ${uploaded}/${total}…`,
            });
          },
        },
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
