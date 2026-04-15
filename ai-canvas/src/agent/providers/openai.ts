import type { ContentPart } from "../types";
import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  ChatResponseToolCall,
  ImageGenRequest,
  ImageGenResponse,
  VideoGenRequest,
  VideoGenResponse,
} from "./base";
import { throwIfError } from "./errors";
import { waitForTask } from "@/services/tasks";
import { aiProxy, saveMedia } from "@/lib/tauri";
import { scheduleBackgroundSave } from "@/lib/media";
import { useProjectStore } from "@/stores/projectStore";

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

function contentToOpenAI(
  content: string | ContentPart[],
): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;
  return content.map((p) => {
    switch (p.type) {
      case "text":
        return { type: "text", text: p.text };
      case "image":
        return { type: "image_url", image_url: { url: p.url } };
      default:
        return { type: "text", text: `[file: ${(p as ContentPart & { type: "file" }).name}]` };
    }
  });
}

export class OpenAIProvider implements AIProvider {
  readonly descriptor = {
    id: "openai",
    name: "OpenAI",
    capabilities: ["chat", "vision", "tool_calling", "image_gen", "video_gen"] as const,
  };

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: req.systemPrompt },
    ];

    for (const msg of req.messages) {
      if (msg.role === "assistant" && msg.toolCalls?.length) {
        messages.push({
          role: "assistant",
          content: msg.content ? contentToOpenAI(msg.content) : null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });
      } else if (msg.role === "tool" && msg.toolCallId) {
        messages.push({
          role: "tool",
          tool_call_id: msg.toolCallId,
          content:
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content),
        });
      } else {
        messages.push({
          role: msg.role,
          content: contentToOpenAI(msg.content),
        });
      }
    }

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
    };
    if (req.tools?.length) body.tools = req.tools;
    if (req.maxTokens) body.max_tokens = req.maxTokens;

    const raw = await aiProxy("openai", "/v1/chat/completions", body);
    throwIfError(raw.status, raw.body);

    const data = JSON.parse(raw.body);
    const choice = data.choices?.[0];
    if (!choice) throw new Error("No response from model");

    const toolCalls: ChatResponseToolCall[] = (
      choice.message.tool_calls ?? []
    ).map(
      (tc: {
        id: string;
        function: { name: string; arguments: string };
      }) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }),
    );

    return {
      content: choice.message.content ?? null,
      toolCalls,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      },
      finishReason: choice.finish_reason === "tool_calls" ? "tool_calls" : "stop",
    };
  }

  async generateImage(req: ImageGenRequest): Promise<ImageGenResponse> {
    const rawSize = req.size || "1024x1024";
    const size = toAspectRatio(rawSize);
    const emit = req.onProgress;

    emit?.({ percent: 0, phase: "submitting", label: "正在提交请求…" });

    const body: Record<string, unknown> = {
      model: req.model ?? "gpt-image-1.5",
      prompt: req.prompt,
      size,
      quality: req.quality || "standard",
      n: 1,
      response_format: "url",
    };

    if (req.referenceImages && req.referenceImages.length > 0) {
      body.images = req.referenceImages.map((ref) => ref.url);
    }

    console.group("[OpenAI] generateImage 请求");
    console.log("[OpenAI] 请求体（不含图片数据）:", {
      model: body.model,
      promptLength: req.prompt.length,
      promptPreview: req.prompt.slice(0, 300),
      size: body.size,
      quality: body.quality,
      n: body.n,
      response_format: body.response_format,
      hasImagesField: !!body.images,
      imagesCount: Array.isArray(body.images) ? (body.images as unknown[]).length : 0,
      imageUrlPrefixes: Array.isArray(body.images)
        ? (body.images as string[]).map((u) => u.slice(0, 60))
        : [],
    });

    const raw = await aiProxy("openai", "/v1/images/generations", body);

    console.log("[OpenAI] 响应状态:", raw.status);
    console.log("[OpenAI] 响应体预览:", raw.body.slice(0, 500));
    console.groupEnd();

    throwIfError(raw.status, raw.body);

    const taskIdMatch = raw.body.match(/"task_id"\s*:\s*(\d+)/);
    const data = JSON.parse(raw.body);

    if (data.task_id || taskIdMatch) {
      const taskId = taskIdMatch ? taskIdMatch[1]! : String(data.task_id);
      console.log("[OpenAI] 异步任务模式, taskId:", taskId);

      emit?.({ percent: 5, phase: "queued", label: "已提交，排队中…" });

      const result = await waitForTask(taskId, (progress, status) => {
        const st = status.toLowerCase();
        if (st === "queued" || st === "pending") {
          emit?.({ percent: Math.max(5, progress), phase: "queued", label: "排队中…" });
        } else {
          const pct = progress > 0 ? Math.min(progress, 90) : 10;
          emit?.({ percent: pct, phase: "generating", label: "生成中…" });
        }
      });

      console.log("[OpenAI] 任务完成:", {
        status: result.status,
        resultUrl: result.resultUrl?.slice(0, 150),
        errorMessage: result.errorMessage,
      });

      const failed = result.status.toLowerCase();
      if (failed === "failed" || failed === "error" || failed === "cancelled") {
        throw new Error(result.errorMessage || "图片生成失败");
      }
      if (!result.resultUrl) {
        throw new Error("图片生成完成但未返回结果地址");
      }

      emit?.({ percent: 92, phase: "saving", label: "正在保存图片…" });
      const pid = useProjectStore.getState().currentProjectId ?? undefined;
      try {
        const saved = await saveMedia(result.resultUrl, undefined, undefined, pid);
        console.log("[OpenAI] 图片已保存:", saved.localPath);
        emit?.({ percent: 100, phase: "saving", label: "完成" });
        return { url: saved.localPath };
      } catch (e) {
        console.warn("[OpenAI] 本地保存失败，降级使用远程地址:", e);
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
    } catch (e) {
      console.warn("[OpenAI] 本地保存失败，降级使用远程地址:", e);
      emit?.({ percent: 100, phase: "saving", label: "完成（使用远程地址）" });
      return { url: img.url, revisedPrompt: img.revised_prompt };
    }
  }

  async generateVideo(req: VideoGenRequest): Promise<VideoGenResponse> {
    const emit = req.onProgress;
    emit?.({ percent: 0, phase: "submitting", label: "正在提交视频请求…" });

    const body: Record<string, unknown> = {
      model: req.model ?? "veo3.1-fast",
      stream: false,
      messages: [{ role: "user", content: req.prompt }],
    };

    if (req.size && req.size !== "auto") {
      body.aspect_ratio = req.size;
    }

    const raw = await aiProxy("openai", "/v1/chat/completions", body);
    throwIfError(raw.status, raw.body);

    const data = JSON.parse(raw.body);

    const taskIdMatch = raw.body.match(/"task_id"\s*:\s*(\d+)/);
    if (data.task_id || taskIdMatch) {
      const taskId = taskIdMatch ? taskIdMatch[1]! : String(data.task_id);
      emit?.({ percent: 5, phase: "queued", label: "已提交，排队中…" });

      const result = await waitForTask(taskId, (progress, status) => {
        const st = status.toLowerCase();
        if (st === "queued" || st === "pending") {
          emit?.({ percent: Math.max(5, progress), phase: "queued", label: "排队中…" });
        } else {
          const pct = progress > 0 ? Math.min(progress, 90) : 10;
          emit?.({ percent: pct, phase: "generating", label: "视频生成中…" });
        }
      });

      const failed = result.status.toLowerCase();
      if (failed === "failed" || failed === "error" || failed === "cancelled") {
        throw new Error(result.errorMessage || "视频生成失败");
      }
      if (!result.resultUrl) {
        throw new Error("视频生成完成但未返回结果地址");
      }

      emit?.({ percent: 92, phase: "saving", label: "正在保存视频…" });
      const pid = useProjectStore.getState().currentProjectId ?? undefined;
      try {
        const saved = await saveMedia(result.resultUrl, undefined, undefined, pid);
        emit?.({ percent: 100, phase: "saving", label: "完成" });
        return { url: saved.localPath };
      } catch (e) {
        console.warn("[OpenAI] 视频本地保存失败，降级使用远程地址:", e);
        emit?.({ percent: 100, phase: "saving", label: "完成（使用远程地址）" });
        return { url: result.resultUrl };
      }
    }

    const content = data.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      const urlMatch = content.match(/https?:\/\/\S+\.(mp4|webm|mov)/i);
      if (urlMatch) {
        emit?.({ percent: 80, phase: "saving", label: "正在保存视频…" });
        const pid = useProjectStore.getState().currentProjectId ?? undefined;
        try {
          const saved = await saveMedia(urlMatch[0], undefined, undefined, pid);
          emit?.({ percent: 100, phase: "saving", label: "完成" });
          return { url: saved.localPath };
        } catch (e) {
          console.warn("[OpenAI] 视频本地保存失败，降级使用远程地址:", e);
          emit?.({ percent: 100, phase: "saving", label: "完成（使用远程地址）" });
          return { url: urlMatch[0] };
        }
      }
    }

    throw new Error("未能从响应中获取视频地址");
  }
}
