import type {
  AIProvider,
  VideoGenRequest,
  VideoGenResponse,
  ChatRequest,
  ChatResponse,
} from "./base";
import { throwIfError } from "./errors";
import { waitForTask } from "@/services/tasks";
import { aiProxy, saveMedia } from "@/lib/tauri";
import { useProjectStore } from "@/stores/projectStore";

const SEEDANCE_ENDPOINT = "/seedance/v3/contents/generations/tasks";
const SEEDANCE_POLL_ENDPOINT = "/seedance/v3/contents/generations/tasks/{task_id}";

function toSeedanceRatio(size: string): string | undefined {
  if (!size || size === "auto") return undefined;
  if (size.includes(":")) return size;
  const m = size.match(/^(\d+)x(\d+)$/);
  if (!m) return size;
  const w = Number(m[1]);
  const h = Number(m[2]);
  const ratioMap: Record<string, string> = {
    "16:9": "16:9",
    "4:3": "4:3",
    "1:1": "1:1",
    "3:4": "3:4",
    "9:16": "9:16",
    "21:9": "21:9",
  };
  const gcdFn = (a: number, b: number): number => (b === 0 ? a : gcdFn(b, a % b));
  const d = gcdFn(w, h);
  const key = `${w / d}:${h / d}`;
  return ratioMap[key] ?? key;
}

export class SeedanceProvider implements AIProvider {
  readonly descriptor = {
    id: "seedance",
    name: "Seedance",
    capabilities: ["video_gen"] as const,
  };

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("SeedanceProvider 不支持对话，请使用视频生成功能");
  }

  async generateVideo(req: VideoGenRequest): Promise<VideoGenResponse> {
    const emit = req.onProgress;
    emit?.({ percent: 0, phase: "submitting", label: "正在提交视频请求…" });

    const content: Array<Record<string, unknown>> = [];

    if (req.prompt) {
      content.push({ type: "text", text: req.prompt });
    }

    if (req.referenceImages && req.referenceImages.length > 0) {
      for (const ref of req.referenceImages) {
        const role =
          ref.role === "firstFrame"
            ? "first_frame"
            : ref.role === "lastFrame"
              ? "last_frame"
              : "reference_image";

        content.push({
          type: "image_url",
          image_url: { url: ref.url },
          role,
        });
      }
    }

    const body: Record<string, unknown> = {
      model: req.model ?? "doubao-seedance-2-0-v2-250528",
      content,
    };

    const ratio = toSeedanceRatio(req.size ?? "");
    if (ratio) {
      body.ratio = ratio;
    }

    if (req.duration != null) {
      body.duration = req.duration;
    }
    if (req.resolution) {
      body.resolution = req.resolution;
    }
    if (req.generateAudio != null) {
      body.generate_audio = req.generateAudio;
    }
    if (req.seed != null && req.seed !== -1) {
      body.seed = req.seed;
    }
    if (req.watermark != null) {
      body.watermark = req.watermark;
    }

    console.log("[Seedance] generateVideo 请求:", {
      model: body.model,
      contentItems: content.length,
      promptPreview: req.prompt.slice(0, 200),
      ratio: body.ratio,
    });

    const raw = await aiProxy("openai", SEEDANCE_ENDPOINT, body);
    throwIfError(raw.status, raw.body);

    const data = JSON.parse(raw.body);

    const taskId = data.id ?? data.task_id;
    if (!taskId) {
      throw new Error("未能从响应中获取视频任务 ID");
    }

    console.log("[Seedance] 任务已提交, taskId:", taskId);
    emit?.({ percent: 5, phase: "queued", label: "已提交，排队中…" });

    const result = await waitForTask(
      String(taskId),
      (progress, status) => {
        const st = status.toLowerCase();
        if (st === "queued" || st === "pending") {
          emit?.({
            percent: Math.max(5, progress),
            phase: "queued",
            label: "排队中…",
          });
        } else {
          const pct = progress > 0 ? Math.min(progress, 90) : 10;
          emit?.({ percent: pct, phase: "generating", label: "视频生成中…" });
        }
      },
      undefined,
      SEEDANCE_POLL_ENDPOINT,
    );

    const failed = result.status.toLowerCase();
    if (
      failed === "failed" ||
      failed === "error" ||
      failed === "cancelled" ||
      failed === "expired"
    ) {
      throw new Error(result.errorMessage || "视频生成失败");
    }
    if (!result.resultUrl) {
      throw new Error("视频生成完成但未返回结果地址");
    }

    emit?.({ percent: 92, phase: "saving", label: "正在保存视频…" });
    const pid = useProjectStore.getState().currentProjectId ?? undefined;
    try {
      const saved = await saveMedia(
        result.resultUrl,
        undefined,
        undefined,
        pid,
      );
      emit?.({ percent: 100, phase: "saving", label: "完成" });
      return { url: saved.localPath };
    } catch (e) {
      console.warn(
        "[Seedance] 视频本地保存失败，降级使用远程地址:",
        e,
      );
      emit?.({
        percent: 100,
        phase: "saving",
        label: "完成（使用远程地址）",
      });
      return { url: result.resultUrl };
    }
  }
}
