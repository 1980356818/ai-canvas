import { OpenAICompatProvider } from "../openai-compat";
import {
  ALL_JIJING_MODELS,
  resolveJiJingImageModelId,
  isJiJingSeedanceModel,
  isJiJingVeoModel,
  isJiJingGrokVideoModel,
  isJiJingSeedanceVipModel,
  isJiJingSeedanceV2Model,
  isJiJingOmniModel,
  isJiJingOmniEditModel,
} from "./models";
import { toSeedanceRatio, toVeoAspectRatio, toOmniAspectRatio } from "../shared/video";
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

  resolveImageModelId(baseId: string, resolution: string, quality?: string): string {
    return resolveJiJingImageModelId(baseId, resolution, quality);
  }

  async generateVideo(req: VideoGenRequest): Promise<VideoGenResponse> {
    const model = req.model ?? "";
    // V161 火山方舟原生 Seedance 2.0 — 4 个具体 model 或 alias `seedance-v2`.
    // 顺序敏感: 必须在 isSeedanceVipModel 之前匹配, 因为 V145 VIP 系列
    // 也包含 `seedance-2-0` 这个 id (含义不同 — V145 客户端把它当 alias,
    // V161 服务端把它当具体 model). 模型注册表里我们已经把 `seedance-2-0`
    // 划给 VIP, V161 客户端走 alias `seedance-v2` 或 V161 后端具体 model
    // (seedance-2-0-fast / -video-ref / -fast-video-ref), 不复用 `seedance-2-0`,
    // 所以这里两个判定的交集只有 V161 路径下"用户从老卡片拷贝 model_name"
    // 这种异常场景, 优先走 V161 协议是更安全的兜底.
    if (isJiJingSeedanceV2Model(model)) {
      return this.generateSeedanceV2Video(req);
    }
    // VIP 独立分支: 协议简化 (无 Volcano content[] / reference_mode), 优先匹配
    // 避免落到 isSeedanceModel — 后者只识别旧 Dale 系 SKU, 跟 VIP 互斥.
    if (isJiJingSeedanceVipModel(model)) {
      return this.generateSeedanceVipVideo(req);
    }
    if (isJiJingVeoModel(model) || isJiJingSeedanceModel(model) || isJiJingGrokVideoModel(model)) {
      if (isJiJingSeedanceModel(model) && req.referenceVideos?.length) {
        throw new Error(
          "Seedance 当前不支持参考视频，请改用参考图或参考音频（或切到其他模型）",
        );
      }
      return this.generateGatewayVideo(req);
    }
    // Omni (Veo Omni Flash): req.model 已由 buildVideoRequest 经 resolveOmniModelId
    // resolve 成 omni / omni-edit, 这里按编辑态决定 body 形态.
    if (isJiJingOmniModel(model)) {
      return this.generateOmniVideo(req);
    }
    return super.generateVideo(req);
  }

  /**
   * Seedance 2.0 VIP (极境 Nexus 网关) 专用生成路径 — V138 重构.
   *
   * 协议跟 jijing-server NexusVideoAdapter (V138) 对齐:
   *   POST /v1/videos/generations
   *     {model, prompt, size, images?, videos?}
   *
   * V138 变化:
   *   - quality 字段废弃 (model_name 已细到具体上游, 不再需要二级开关)
   *   - duration 不传 (后端固定 15 秒)
   *   - size 必须是具体像素 (1280x720 / 1920x1080 / 720x1280 / 1080x1920),
   *     1080P 路径不能只发 aspect_ratio 否则后端会推断成 720P.
   *
   * model 字段由 VideoEditor.handleGenerate 先经 resolveSeedanceVipModelId
   * resolve 到 4 个主上游之一, 或直接是 economy 项 model_name.
   * 这里只负责扁平化, 不再做 model 选择.
   */
  private async generateSeedanceVipVideo(req: VideoGenRequest): Promise<VideoGenResponse> {
    return await executeAsyncMediaTask({
      providerId: this.descriptor.id,
      submitEndpoint: JIJING_VIDEO_ENDPOINT,
      body: this.buildSeedanceVipBody(req),
      emit: req.onProgress,
      expectedSec: PROGRESS_EXPECTED_SEC.videoSeedance,
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

  /**
   * V161 火山方舟原生 Seedance 2.0 生成路径 — 直连 ark.cn-beijing.volces.com.
   *
   * 协议跟 jijing-server VolcanoArkVideoAdapter 对齐:
   *   POST /v1/videos/generations
   *     {model, prompt, duration, ratio, resolution, generate_audio,
   *      watermark, seed, images?, videos?, audios?}
   *
   * 调用方需要在传入 req.model 前已 resolve 完聚合 alias (`seedance-v2`)
   * 到 4 个具体上游 (seedance-2-0 / -fast / -video-ref / -fast-video-ref),
   * 见 {@link resolveSeedanceV2ModelId}.
   *
   * 计费走 PER_TOKEN_PREPAID: 提交 hasVideos 决定预扣 20 或 40 元,
   * 完成后按 usage.completion_tokens × pricing[model][resolution][hasVideoInput]
   * 实结算, 余额多退少补. UI 上 "version 切换" 只影响画质 / token 单价,
   * 不影响预扣金额.
   *
   * 区别于 generateGatewayVideo: 不发 reference_mode (那是 Dale Seedance
   * 老协议字段, 火山自己按 content 数组里的 type 字段识别 reference 类型).
   */
  private async generateSeedanceV2Video(req: VideoGenRequest): Promise<VideoGenResponse> {
    return await executeAsyncMediaTask({
      providerId: this.descriptor.id,
      submitEndpoint: JIJING_VIDEO_ENDPOINT,
      body: this.buildSeedanceV2Body(req),
      emit: req.onProgress,
      expectedSec: PROGRESS_EXPECTED_SEC.videoSeedance,
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

  private buildSeedanceV2Body(req: VideoGenRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      prompt: req.prompt,
      model: req.model,
    };
    // ratio: 火山接受 16:9/9:16/4:3/3:4/1:1/21:9/adaptive 字符串;
    // toSeedanceRatio 把 canvas 的 "1280x720" / "auto" 翻成 ratio.
    const aspect = req.ratio ?? toSeedanceRatio(req.size);
    if (aspect) body.aspect_ratio = aspect;
    if (req.duration != null) body.duration = req.duration;
    if (req.resolution) body.resolution = req.resolution;
    if (req.generateAudio != null) body.generate_audio = req.generateAudio;
    if (req.seed != null && req.seed !== -1) body.seed = req.seed;
    if (req.watermark != null) body.watermark = req.watermark;

    if (req.referenceImages?.length) {
      body.images = req.referenceImages.map((ref) => ({ url: ref.url, role: ref.role }));
    }
    if (req.referenceAudios?.length) {
      body.audios = req.referenceAudios.map((ref) => ({ url: ref.url, role: ref.role }));
    }
    if (req.referenceVideos?.length) {
      body.videos = req.referenceVideos.map((ref) => ({ url: ref.url, role: ref.role }));
    }
    // 不发 reference_mode — 火山按 content[] type 字段识别, 不需要这个旧 Dale 协议字段.
    return body;
  }

  /**
   * Omni (Veo Omni Flash) 生成路径 — 极境 DSF/甜甜圈 网关 (jijing-server V188).
   *
   * 协议跟 jijing-server DsfOmniVideoAdapter 对齐:
   *   POST /v1/videos/generations
   *     omni:      {model:"omni", prompt, aspect_ratio, video_type, images?}
   *     omni-edit: {model:"omni-edit", prompt, aspect_ratio, videos:[源], images?}
   *
   * 调用方 (buildVideoRequest) 已按 hasVideos 经 resolveOmniModelId resolve 完
   * req.model (omni / omni-edit), 这里只负责扁平化 body, 不再做 model 选择.
   * 固定 10s (后端强制), 故不发 duration / generate_audio / resolution.
   */
  private async generateOmniVideo(req: VideoGenRequest): Promise<VideoGenResponse> {
    return await executeAsyncMediaTask({
      providerId: this.descriptor.id,
      submitEndpoint: JIJING_VIDEO_ENDPOINT,
      body: this.buildOmniBody(req),
      emit: req.onProgress,
      expectedSec: PROGRESS_EXPECTED_SEC.videoOmni,
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

  private buildOmniBody(req: VideoGenRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      prompt: req.prompt,
      model: req.model,
    };
    // omni 仅 16:9 / 9:16; ratio 优先, 否则由 size 换算 (非法值兜底 16:9).
    body.aspect_ratio = req.ratio ?? toOmniAspectRatio(req.size);

    if (isJiJingOmniEditModel(req.model ?? "")) {
      // 视频编辑: 源视频走 videos (后端取首个塞顶层 video_url), 参考图可选.
      if (req.referenceVideos?.length) {
        body.videos = req.referenceVideos.map((ref) => ({ url: ref.url, role: ref.role }));
      }
    } else if (req.videoType) {
      // 生成: video_type 区分 t2v/i2v/r2v; i2v 与 r2v 共用 images 字段 (后端按 video_type 解释).
      body.video_type = req.videoType;
    }
    if (req.referenceImages?.length) {
      // i2v 时 images 顺序即首/尾帧 (referenceImages 已按 firstFrame→lastFrame 入序).
      body.images = req.referenceImages.map((ref) => ({ url: ref.url, role: ref.role }));
    }
    return body;
  }

  private buildSeedanceVipBody(req: VideoGenRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      prompt: req.prompt,
      model: req.model,
    };
    // V138: 后端 form_schema size 字段是具体像素 (1280x720/720x1280/1920x1080/1080x1920).
    // canvas 上层已经 resolve 完 (resolveSeedanceVipSize), 这里若 req.size 形如 NxN 直接透传;
    // 否则退化到 aspect_ratio 让后端 resolveSize 推断 720P (兜底, 不应到这里).
    if (req.size && /^\d+x\d+$/.test(req.size)) {
      body.size = req.size;
    } else {
      const aspect = req.ratio ?? toSeedanceRatio(req.size);
      if (aspect) body.aspect_ratio = aspect;
    }
    if (req.referenceImages?.length) {
      body.images = req.referenceImages.map((ref) => ({ url: ref.url, role: ref.role }));
    }
    if (req.referenceVideos?.length) {
      body.videos = req.referenceVideos.map((ref) => ({ url: ref.url, role: ref.role }));
    }
    // 不传 duration (后端固定 15s), 不传 quality (V138 废弃).
    return body;
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
      cardId: req.cardId,
      kind: "video_gen",
    });
  }

  private buildGatewayBody(req: VideoGenRequest, seedance: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      prompt: req.prompt,
      model: req.model,
    };
    const veo = isJiJingVeoModel(req.model ?? "");
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
      if (veo) {
        // Cat 三模式分发看 body 字段名 (CatVideoAdapter L102-111):
        //   referenceImages 非空 → type=3 ref (multipart, 强制 8s, fast 限 2 张)
        //   images 非空 → type=2 i2v (首尾帧, 强制 8s)
        // VideoEditor 通过 imageMode 切换 role: firstFrame/lastFrame → i2v; referenceImage → ref.
        // 这里按 role 拆字段, 让后端走正确模式.
        const frameImages: Array<{ url: string; role: string }> = [];
        const refImages: Array<{ url: string; role: string }> = [];
        for (const ref of req.referenceImages) {
          if (ref.role === "firstFrame" || ref.role === "lastFrame") {
            frameImages.push({ url: ref.url, role: ref.role });
          } else {
            refImages.push({ url: ref.url, role: ref.role });
          }
        }
        if (frameImages.length > 0) body.images = frameImages;
        if (refImages.length > 0) body.referenceImages = refImages;
      } else {
        body.images = req.referenceImages.map((ref) => ({ url: ref.url, role: ref.role }));
      }
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
