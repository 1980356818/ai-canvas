import { OpenAICompatProvider } from "../openai-compat";
import {
  ALL_COMFLY_MODELS,
  resolveComflyImageModelId,
  getComflyDisplayName,
  isSeedanceModel,
  isVeoModel,
} from "./models";
import {
  resolveSeedanceUpstreamModel,
  resolveVeoUpstreamModel,
  toVeoAspectRatio,
  buildSeedanceBody,
} from "../shared/video";
import { executeAsyncMediaTask } from "../shared/asyncMediaTask";
import { PROGRESS_EXPECTED_SEC } from "../shared/progress";
import type { VideoGenRequest, VideoGenResponse } from "../types";
import type { ModelInfo } from "@/types";

const SEEDANCE_ENDPOINT = "/seedance/v3/contents/generations/tasks";
const SEEDANCE_POLL_ENDPOINT = "/seedance/v3/contents/generations/tasks/{task_id}";

// Comfly Veo: 上游 /v1/videos/generations 已废弃 (实测 404), 现在走 v2 plural。
// poll 端点必须显式给出 — 默认 /v1/tasks/{id} 在 Comfly 上是 404。
const VEO_ENDPOINT = "/v2/videos/generations";
const VEO_POLL_ENDPOINT = "/v2/videos/generations/{task_id}";

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
    const model = req.model ?? "";
    if (isSeedanceModel(model)) return this.generateSeedanceVideo(req);
    if (isVeoModel(model)) return this.generateVeoVideo(req);
    return super.generateVideo(req);
  }

  private async generateVeoVideo(req: VideoGenRequest): Promise<VideoGenResponse> {
    const body: Record<string, unknown> = {
      prompt: req.prompt,
      model: resolveVeoUpstreamModel(req.model),
    };
    if (req.referenceImages?.length) {
      body.images = req.referenceImages.map((ref) => ref.url);
    }
    const ratio = req.ratio ?? toVeoAspectRatio(req.size);
    if (ratio) body.aspect_ratio = ratio;
    if (req.duration != null) body.duration = req.duration;
    if (req.seed != null && req.seed !== -1) body.seed = req.seed;
    if (req.callbackUrl) body.callback_url = req.callbackUrl;

    return await executeAsyncMediaTask({
      providerId: this.descriptor.id,
      submitEndpoint: VEO_ENDPOINT,
      pollEndpoint: VEO_POLL_ENDPOINT,
      body,
      emit: req.onProgress,
      expectedSec: PROGRESS_EXPECTED_SEC.videoVeo,
      generatingLabel: "视频生成中…",
      submittingLabel: "正在提交视频请求…",
      savingLabel: "正在保存视频…",
      failedFallbackMessage: "视频生成失败",
      projectId: req.projectId,
      title: req.prompt,
    });
  }

  private async generateSeedanceVideo(req: VideoGenRequest): Promise<VideoGenResponse> {
    return await executeAsyncMediaTask({
      providerId: this.descriptor.id,
      submitEndpoint: SEEDANCE_ENDPOINT,
      pollEndpoint: SEEDANCE_POLL_ENDPOINT,
      body: buildSeedanceBody(resolveSeedanceUpstreamModel(req.model), req),
      emit: req.onProgress,
      expectedSec: PROGRESS_EXPECTED_SEC.videoSeedance,
      generatingLabel: "视频生成中…",
      submittingLabel: "正在提交视频请求…",
      savingLabel: "正在保存视频…",
      failedFallbackMessage: "视频生成失败",
      projectId: req.projectId,
      title: req.prompt,
    });
  }
}
