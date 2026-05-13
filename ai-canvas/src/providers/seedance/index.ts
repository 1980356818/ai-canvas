import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  StreamEvent,
  VideoGenRequest,
  VideoGenResponse,
} from "../types";
import { SEEDANCE_MODELS, resolveModel } from "./models";
import { buildSeedanceBody } from "../shared/video";
import { executeAsyncMediaTask } from "../shared/asyncMediaTask";
import { PROGRESS_EXPECTED_SEC } from "../shared/progress";
import type { ModelInfo } from "@/types";

const SEEDANCE_ENDPOINT = "/seedance/v3/contents/generations/tasks";
const SEEDANCE_POLL_ENDPOINT = "/seedance/v3/contents/generations/tasks/{task_id}";

export class SeedanceProvider implements AIProvider {
  readonly descriptor = {
    id: "seedance" as const,
    name: "Seedance (豆包)",
    capabilities: ["video_gen"] as const,
    configSchema: [],
  };

  async listModels(): Promise<ModelInfo[]> {
    return SEEDANCE_MODELS;
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("SeedanceProvider 不支持对话，请使用视频生成功能");
  }

  async streamChat(
    _req: ChatRequest,
    _onEvent: (event: StreamEvent) => void,
  ): Promise<{ abort: () => void }> {
    throw new Error("SeedanceProvider 不支持流式对话");
  }

  async generateVideo(req: VideoGenRequest): Promise<VideoGenResponse> {
    // SeedanceProvider 没有自己的 aiProxy provider id (Comfly 才是上游),
    // 沿用 comfly 渠道走 Tauri 的 ai_proxy。
    return await executeAsyncMediaTask({
      providerId: "comfly",
      submitEndpoint: SEEDANCE_ENDPOINT,
      pollEndpoint: SEEDANCE_POLL_ENDPOINT,
      body: buildSeedanceBody(resolveModel(req.model), req),
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
