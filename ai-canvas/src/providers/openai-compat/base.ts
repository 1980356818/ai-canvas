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
} from "./formatter";
import { aiProxy, aiProxyStream, listModels as platformListModels, saveMedia } from "@/platform";
import { waitForTask } from "@/services/tasks";
import { useProjectStore } from "@/stores/projectStore";
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
    "16:9": "2560x1440",
    "9:16": "1440x2560",
  },
  "4K": {
    "1:1": "2880x2880",
    "3:2": "3072x2048",
    "2:3": "2048x3072",
    "16:9": "3840x2160",
    "9:16": "2160x3840",
  },
};

function toGptImage2Size(size: string, resolution: string): string | undefined {
  const ratio = toAspectRatio(size);
  return GPT_IMAGE_2_SIZE_MAP[resolution]?.[ratio];
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

  resolveImageModelId(baseId: string, _resolution: string): string {
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
          onEvent({ type: "done" });
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
    const emit = req.onProgress;
    emit?.({ percent: 0, phase: "submitting", label: "正在提交请求…" });

    const body: Record<string, unknown> = {
      model: req.model ?? this.defaultImageModel(),
      n: 1,
      response_format: "url",
    };

    if (req.prompt) {
      body.prompt = req.prompt;
      const baseSize = req.size || "1024x1024";
      const modelId = (req.model ?? this.defaultImageModel()).toLowerCase();
      const isGptImage2 = modelId.startsWith("gpt-image-2");
      const pixelSize = isGptImage2 && req.resolution
        ? toGptImage2Size(baseSize, req.resolution)
        : undefined;
      body.size = pixelSize ?? toAspectRatio(baseSize);
      body.quality = req.quality || "standard";
    }

    if (req.referenceImages?.length) {
      body[this.imageRefField()] = req.referenceImages.map((ref) => ref.url);
    }

    const raw = await aiProxy(this.providerId, "/v1/images/generations", body);
    throwIfError(raw.status, raw.body);

    const data = JSON.parse(raw.body);
    const taskIdMatch = raw.body.match(/"task_id"\s*:\s*(\d+)/);

    if (data.task_id || taskIdMatch) {
      const taskId = taskIdMatch ? taskIdMatch[1]! : String(data.task_id);
      emit?.({ percent: 5, phase: "queued", label: "已提交，排队中…" });

      const result = await waitForTask(
        taskId,
        (progress, status) => {
          const st = status.toLowerCase();
          if (st === "queued" || st === "pending") {
            emit?.({ percent: Math.max(5, progress), phase: "queued", label: "排队中…" });
          } else {
            emit?.({ percent: Math.min(progress, 90) || 10, phase: "generating", label: "生成中…" });
          }
        },
        undefined,
        undefined,
        this.providerId,
      );

      const failed = result.status.toLowerCase();
      if (failed === "failed" || failed === "error" || failed === "cancelled") {
        throw new Error(result.errorMessage || "图片生成失败");
      }
      if (!result.resultUrl) throw new Error("图片生成完成但未返回结果地址");

      emit?.({ percent: 92, phase: "saving", label: "正在保存图片…" });
      const pid = useProjectStore.getState().currentProjectId ?? undefined;
      try {
        const saved = await saveMedia(result.resultUrl, undefined, undefined, pid);
        emit?.({ percent: 100, phase: "saving", label: "完成" });
        return { url: saved.localPath };
      } catch {
        emit?.({ percent: 100, phase: "saving", label: "完成（使用远程地址）" });
        return { url: result.resultUrl };
      }
    }

    emit?.({ percent: 80, phase: "saving", label: "正在保存图片…" });
    const img = data.data?.[0];
    if (!img?.url) throw new Error("No image returned");
    const pid = useProjectStore.getState().currentProjectId ?? undefined;
    try {
      const saved = await saveMedia(img.url, undefined, undefined, pid);
      emit?.({ percent: 100, phase: "saving", label: "完成" });
      return { url: saved.localPath, revisedPrompt: img.revised_prompt };
    } catch {
      emit?.({ percent: 100, phase: "saving", label: "完成（使用远程地址）" });
      return { url: img.url, revisedPrompt: img.revised_prompt };
    }
  }

  async generateVideo(req: VideoGenRequest): Promise<VideoGenResponse> {
    const emit = req.onProgress;
    emit?.({ percent: 0, phase: "submitting", label: "正在提交视频请求…" });

    const body: Record<string, unknown> = {
      prompt: req.prompt,
      model: req.model ?? this.defaultVideoModel(),
    };
    if (req.referenceImages?.length) {
      body.images = req.referenceImages.map((ref) => ref.url);
    }
    if (req.size && req.size !== "auto") {
      body.aspect_ratio = toAspectRatio(req.size);
    }

    const raw = await aiProxy(this.providerId, this.videoEndpoint(), body);
    throwIfError(raw.status, raw.body);

    const data = JSON.parse(raw.body);
    const taskIdMatch = raw.body.match(/"task_id"\s*:\s*(\d+)/);

    if (data.task_id || taskIdMatch) {
      const taskId = taskIdMatch ? taskIdMatch[1]! : String(data.task_id);
      emit?.({ percent: 5, phase: "queued", label: "已提交，排队中…" });

      const result = await waitForTask(
        taskId,
        (progress, status) => {
          const st = status.toLowerCase();
          if (st === "queued" || st === "pending") {
            emit?.({ percent: Math.max(5, progress), phase: "queued", label: "排队中…" });
          } else {
            emit?.({ percent: Math.min(progress, 90) || 10, phase: "generating", label: "视频生成中…" });
          }
        },
        undefined,
        undefined,
        this.providerId,
      );

      const failed = result.status.toLowerCase();
      if (failed === "failed" || failed === "error" || failed === "cancelled") {
        throw new Error(result.errorMessage || "视频生成失败");
      }
      if (!result.resultUrl) throw new Error("视频生成完成但未返回结果地址");

      emit?.({ percent: 92, phase: "saving", label: "正在保存视频…" });
      const pid = useProjectStore.getState().currentProjectId ?? undefined;
      try {
        const saved = await saveMedia(result.resultUrl, undefined, undefined, pid);
        emit?.({ percent: 100, phase: "saving", label: "完成" });
        return { url: saved.localPath };
      } catch {
        emit?.({ percent: 100, phase: "saving", label: "完成（使用远程地址）" });
        return { url: result.resultUrl };
      }
    }

    throw new Error("未能从响应中获取视频任务ID");
  }
}
