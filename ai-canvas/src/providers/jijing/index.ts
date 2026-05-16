import { OpenAICompatProvider } from "../openai-compat";
import {
  ALL_JIJING_MODELS,
  resolveJiJingImageModelId,
  isJiJingSeedanceModel,
  isJiJingVeoModel,
  isJiJingGrokVideoModel,
} from "./models";
import { toSeedanceRatio, toVeoAspectRatio } from "../shared/video";
import { executeAsyncMediaTask } from "../shared/asyncMediaTask";
import { PROGRESS_EXPECTED_SEC } from "../shared/progress";
import type { VideoGenRequest, VideoGenResponse } from "../types";
import type { ModelInfo } from "@/types";

const JIJING_VIDEO_ENDPOINT = "/v1/videos/generations";

export class JiJingProvider extends OpenAICompatProvider {
  readonly descriptor = {
    id: "jijing" as const,
    name: "极境",
    capabilities: ["chat", "vision", "tool_calling", "image_gen", "video_gen", "streaming"] as const,
    // baseUrl 由代码硬编码（Rust default_base_url + Vite proxy），不暴露给用户编辑。
    configSchema: [
      { key: "apiKey", label: "API Key", type: "password" as const, required: true },
    ],
  };

  protected staticModels(): ModelInfo[] {
    return ALL_JIJING_MODELS;
  }

  protected defaultImageModel(): string {
    return "nano-banana-2";
  }

  protected imageRefField(): string {
    return "images";
  }

  resolveImageModelId(baseId: string, resolution: string): string {
    return resolveJiJingImageModelId(baseId, resolution);
  }

  async generateVideo(req: VideoGenRequest): Promise<VideoGenResponse> {
    const model = req.model ?? "";
    if (isJiJingVeoModel(model) || isJiJingSeedanceModel(model) || isJiJingGrokVideoModel(model)) {
      if (isJiJingSeedanceModel(model) && req.referenceVideos?.length) {
        throw new Error(
          "Seedance 当前不支持参考视频，请改用参考图或参考音频（或切到其他模型）",
        );
      }
      return this.generateGatewayVideo(req);
    }
    return super.generateVideo(req);
  }

  private async generateGatewayVideo(req: VideoGenRequest): Promise<VideoGenResponse> {
    const seedance = isJiJingSeedanceModel(req.model ?? "");
    const grok = isJiJingGrokVideoModel(req.model ?? "");
    const expectedSec = seedance
      ? PROGRESS_EXPECTED_SEC.videoSeedance
      : grok
        ? PROGRESS_EXPECTED_SEC.videoVeo
        : PROGRESS_EXPECTED_SEC.videoVeo;

    return await executeAsyncMediaTask({
      providerId: this.descriptor.id,
      submitEndpoint: JIJING_VIDEO_ENDPOINT,
      body: this.buildGatewayBody(req, seedance),
      emit: req.onProgress,
      expectedSec,
      generatingLabel: "视频生成中…",
      submittingLabel: "正在提交视频请求…",
      savingLabel: "正在保存视频…",
      failedFallbackMessage: "视频生成失败",
      projectId: req.projectId,
      title: req.prompt,
    });
  }

  private buildGatewayBody(req: VideoGenRequest, seedance: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      prompt: req.prompt,
      model: req.model,
    };
    // Seedance 接受 "adaptive"; Veo/Grok 不接受 "auto"/"adaptive", 由 helper 落空让
    // 后端走默认值。Canvas 的 ratio 优先级最高 (model_route form_schema 等场景)。
    const aspect = req.ratio
      ?? (seedance ? toSeedanceRatio(req.size) : toVeoAspectRatio(req.size));
    if (aspect) body.aspect_ratio = aspect;
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

    if (req.referenceImages?.length) {
      body.images = req.referenceImages.map((ref) => ({ url: ref.url, role: ref.role }));
    }
    if (req.referenceAudios?.length) {
      body.audios = req.referenceAudios.map((ref) => ({ url: ref.url, role: ref.role }));
    }
    if (req.referenceVideos?.length) {
      body.videos = req.referenceVideos.map((ref) => ({ url: ref.url, role: ref.role }));
    }

    // Seedance 必须显式告诉后端 reference_mode,否则 DaleVideoAdapter 历史"启发式"
    // 会在 images.length === 2 时误判为首尾帧,把图塞 first_frame_image 触发上游报错。
    // 字面值取自 Dale 官方文档 (2026-05-15) curl 示例:
    //   reference_mode=omni_reference  → 参考图/音频/视频通用模式
    //   reference_mode=first_last_frames → 首尾帧专用 (image_file_1=首, image_file_2=尾)
    // 纯文生不传 mode,让上游走默认。
    if (seedance) {
      const hasFrameRole = req.referenceImages?.some(
        (ref) => ref.role === "firstFrame" || ref.role === "lastFrame",
      );
      const hasAnyRef =
        !!req.referenceImages?.length
        || !!req.referenceAudios?.length
        || !!req.referenceVideos?.length;
      if (hasFrameRole) {
        body.reference_mode = "first_last_frames";
      } else if (hasAnyRef) {
        body.reference_mode = "omni_reference";
      }
    }
    return body;
  }
}
