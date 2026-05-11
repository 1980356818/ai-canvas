import { OpenAICompatProvider } from "../openai-compat";
import { ALL_COMFLY_MODELS, resolveComflyImageModelId, getComflyDisplayName, isSeedanceModel } from "./models";
import { resolveModel as resolveSeedanceModel } from "../seedance/models";
import type { VideoGenRequest, VideoGenResponse } from "../types";
import { throwIfError } from "../errors";
import { aiProxy, saveMedia } from "@/platform";
import { waitForTask } from "@/services/tasks";
import type { ModelInfo } from "@/types";

const SEEDANCE_ENDPOINT = "/seedance/v3/contents/generations/tasks";
const SEEDANCE_POLL_ENDPOINT = "/seedance/v3/contents/generations/tasks/{task_id}";

function toSeedanceRatio(size: string): string | undefined {
  if (!size || size === "auto") return undefined;
  if (size.includes(":")) return size;
  const m = size.match(/^(\d+)x(\d+)$/);
  if (!m) return size;
  const w = Number(m[1]);
  const h = Number(m[2]);
  const gcdFn = (a: number, b: number): number => (b === 0 ? a : gcdFn(b, a % b));
  const d = gcdFn(w, h);
  return `${w / d}:${h / d}`;
}

export class ComflyProvider extends OpenAICompatProvider {
  readonly descriptor = {
    id: "comfly" as const,
    name: "Comfly",
    capabilities: ["chat", "vision", "tool_calling", "image_gen", "video_gen", "streaming"] as const,
    configSchema: [
      { key: "apiKey", label: "API Key", type: "password" as const, required: true },
      {
        key: "baseUrl",
        label: "Base URL",
        type: "url" as const,
        required: false,
        default: "https://ai.comfly.chat",
      },
    ],
  };

  protected staticModels(): ModelInfo[] {
    return ALL_COMFLY_MODELS;
  }

  resolveImageModelId(baseId: string, resolution: string): string {
    return resolveComflyImageModelId(baseId, resolution);
  }

  getDisplayName(modelId: string): string | undefined {
    return getComflyDisplayName(modelId);
  }

  async generateVideo(req: VideoGenRequest): Promise<VideoGenResponse> {
    if (isSeedanceModel(req.model ?? "")) {
      return this.generateSeedanceVideo(req);
    }
    return super.generateVideo(req);
  }

  private async generateSeedanceVideo(req: VideoGenRequest): Promise<VideoGenResponse> {
    const emit = req.onProgress;
    emit?.({ percent: 0, phase: "submitting", label: "正在提交视频请求…" });

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

    const body: Record<string, unknown> = {
      model: resolveSeedanceModel(req.model),
      content,
    };
    const ratio = toSeedanceRatio(req.size ?? "");
    if (ratio) body.ratio = ratio;
    if (req.duration != null) body.duration = req.duration;
    if (req.resolution) body.resolution = req.resolution;
    if (req.generateAudio != null) body.generate_audio = req.generateAudio;
    if (req.seed != null && req.seed !== -1) body.seed = req.seed;
    if (req.watermark != null) body.watermark = req.watermark;

    const raw = await aiProxy("comfly", SEEDANCE_ENDPOINT, body);
    throwIfError(raw.status, raw.body);

    const data = JSON.parse(raw.body);
    const taskId = data.id ?? data.task_id;
    if (!taskId) throw new Error("未能从响应中获取视频任务 ID");

    emit?.({ percent: 5, phase: "queued", label: "已提交，排队中…" });

    const result = await waitForTask(
      String(taskId),
      (progress, status) => {
        const st = status.toLowerCase();
        if (st === "queued" || st === "pending") {
          emit?.({ percent: Math.max(5, progress), phase: "queued", label: "排队中…" });
        } else {
          emit?.({ percent: Math.min(progress, 90) || 10, phase: "generating", label: "视频生成中…" });
        }
      },
      undefined,
      SEEDANCE_POLL_ENDPOINT,
    );

    const failed = result.status.toLowerCase();
    if (failed === "failed" || failed === "error" || failed === "cancelled" || failed === "expired") {
      throw new Error(result.errorMessage || "视频生成失败");
    }
    if (!result.resultUrl) throw new Error("视频生成完成但未返回结果地址");

    emit?.({ percent: 92, phase: "saving", label: "正在保存视频…" });
    const pid = req.projectId;
    try {
      const saved = await saveMedia(result.resultUrl, undefined, undefined, pid);
      emit?.({ percent: 100, phase: "saving", label: "完成" });
      return { url: saved.localPath };
    } catch {
      emit?.({ percent: 100, phase: "saving", label: "完成（使用远程地址）" });
      return { url: result.resultUrl };
    }
  }
}
