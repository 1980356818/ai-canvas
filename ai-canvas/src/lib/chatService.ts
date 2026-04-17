import { aiProxy, aiProxyStream, saveMedia } from "@/lib/tauri";
import { getBase64ForApi } from "@/lib/media";
import { waitForTask } from "@/services/tasks";

// ── Types ───────────────────────────────────────────────────

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string; prompt?: string }
  | { type: "video"; url: string; prompt?: string; coverUrl?: string }
  | { type: "loading"; mediaType: "image" | "video" };

export type Intent = "chat" | "image" | "video";

export interface IntentResult {
  intent: Intent;
  prompt: string;
}

export interface ChatServiceCallbacks {
  onStreamChunk?: (text: string) => void;
  onStreamDone?: () => void;
  onIntentDetected?: (intent: Intent) => void;
  onMediaGenerating?: (mediaType: "image" | "video") => void;
  onMediaProgress?: (progress: number, status: string) => void;
}

export interface ChatHistoryMessage {
  role: "user" | "assistant" | "system";
  content: ChatContentPart[];
}

// ── Intent parsing ──────────────────────────────────────────

export function parseIntent(input: string): IntentResult {
  const trimmed = input.trim();
  if (trimmed.startsWith("/image ")) {
    return { intent: "image", prompt: trimmed.slice(7).trim() };
  }
  if (trimmed.startsWith("/video ")) {
    return { intent: "video", prompt: trimmed.slice(7).trim() };
  }
  return { intent: "chat", prompt: trimmed };
}

const VALID_SIZES = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);

export function extractSizeFromPrompt(prompt: string): { cleanPrompt: string; size?: string } {
  const match = prompt.match(/\b(\d{1,2}:\d{1,2})\b/);
  if (match && match[1] && VALID_SIZES.has(match[1])) {
    return { cleanPrompt: prompt.replace(match[0], "").replace(/\s{2,}/g, " ").trim(), size: match[1] };
  }
  return { cleanPrompt: prompt };
}

// ── Chat completion (streaming) ─────────────────────────────

const CHAT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "generate_image",
      description:
        "When the user asks to generate, draw, create, or design an image/picture/illustration, call this function.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Detailed English prompt for image generation",
          },
          size: {
            type: "string",
            description: "Image aspect ratio. Extract from user request if specified (e.g. 9:16, 16:9, 4:3, 3:4, 1:1). Default is 1:1.",
            enum: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
          },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "generate_video",
      description:
        "When the user asks to generate, create, or make a video/animation/clip, call this function.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Detailed English prompt for video generation",
          },
        },
        required: ["prompt"],
      },
    },
  },
];

async function historyToOpenAI(
  history: ChatHistoryMessage[],
): Promise<Array<Record<string, unknown>>> {
  const result: Array<Record<string, unknown>> = [];

  for (const msg of history) {
    const parts: Array<Record<string, unknown>> = [];

    for (const p of msg.content) {
      if (p.type === "text") {
        parts.push({ type: "text", text: p.text });
      } else if (p.type === "image") {
        const apiUrl = await getBase64ForApi(p.url);
        parts.push({ type: "image_url", image_url: { url: apiUrl } });
      } else if (p.type === "video") {
        const apiUrl = await getBase64ForApi(p.url);
        parts.push({ type: "video_url", video_url: { url: apiUrl } });
      }
    }

    if (parts.length === 0) continue;

    if (parts.length === 1 && parts[0]!.type === "text") {
      result.push({ role: msg.role, content: (parts[0] as { text: string }).text });
    } else {
      result.push({ role: msg.role, content: parts });
    }
  }

  return result;
}

export async function chatCompletion(
  history: ChatHistoryMessage[],
  model: string,
  callbacks: ChatServiceCallbacks,
): Promise<ChatContentPart[]> {
  const historyMessages = await historyToOpenAI(history);
  const messages: Array<Record<string, unknown>> = [
    {
      role: "system",
      content:
        "You are a helpful AI assistant. You can have conversations, and when the user asks you to generate images or videos, use the provided tools. Always respond in the user's language.",
    },
    ...historyMessages,
  ];

  const body: Record<string, unknown> = {
    model,
    messages,
    tools: CHAT_TOOLS,
    stream: true,
  };

  let fullText = "";
  let toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }> = [];

  const tcAccum: Record<
    number,
    { id: string; name: string; arguments: string }
  > = {};

  return new Promise((resolve, reject) => {
    aiProxyStream("openai", "/v1/chat/completions", body, {
      onChunk(data: string) {
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) return;

          if (delta.content) {
            fullText += delta.content;
            callbacks.onStreamChunk?.(delta.content);
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!tcAccum[idx]) {
                tcAccum[idx] = {
                  id: tc.id ?? "",
                  name: tc.function?.name ?? "",
                  arguments: "",
                };
              }
              if (tc.id) tcAccum[idx]!.id = tc.id;
              if (tc.function?.name) tcAccum[idx]!.name = tc.function.name;
              if (tc.function?.arguments)
                tcAccum[idx]!.arguments += tc.function.arguments;
            }
          }
        } catch {
          // skip malformed chunks
        }
      },
      onDone() {
        toolCalls = Object.values(tcAccum);
        processResult();
      },
      onError(error: string) {
        reject(new Error(error));
      },
    }).catch(reject);

    async function processResult() {
      const result: ChatContentPart[] = [];

      if (fullText) {
        result.push({ type: "text", text: fullText });
      }

      for (const tc of toolCalls) {
        try {
          const args = JSON.parse(tc.arguments);
          if (tc.name === "generate_image") {
            callbacks.onMediaGenerating?.("image");
            const imgResult = await generateImage(
              args.prompt,
              undefined,
              callbacks.onMediaProgress,
              args.size,
            );
            result.push({
              type: "image",
              url: imgResult.url,
              prompt: args.prompt,
            });
          } else if (tc.name === "generate_video") {
            callbacks.onMediaGenerating?.("video");
            const vidResult = await generateVideo(
              args.prompt,
              undefined,
              callbacks.onMediaProgress,
            );
            result.push({
              type: "video",
              url: vidResult.url,
              prompt: args.prompt,
            });
          }
        } catch (e) {
          result.push({
            type: "text",
            text: `\n\n> Generation failed: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }

      callbacks.onStreamDone?.();
      resolve(result);
    }
  });
}

// ── Image generation ────────────────────────────────────────

export async function generateImage(
  prompt: string,
  model?: string,
  onProgress?: (progress: number, status: string) => void,
  size?: string,
): Promise<{ url: string; revisedPrompt?: string }> {
  const body: Record<string, unknown> = {
    model: model ?? "gemini-3.1-flash-image-preview-2k",
    prompt,
    size: size || "1:1",
    quality: "standard",
    n: 1,
    response_format: "url",
  };

  onProgress?.(0, "submitting");

  const raw = await aiProxy("openai", "/v1/images/generations", body);
  if (raw.status >= 400) {
    throw new Error(`Image generation failed (HTTP ${raw.status}): ${raw.body}`);
  }

  const data = JSON.parse(raw.body);

  const taskIdMatch = raw.body.match(/"task_id"\s*:\s*(\d+)/);
  if (data.task_id || taskIdMatch) {
    const taskId = taskIdMatch ? taskIdMatch[1]! : String(data.task_id);
    onProgress?.(5, "queued");
    const result = await waitForTask(taskId, (progress, status) => {
      onProgress?.(Math.max(5, Math.min(90, progress)), status);
    });
    if (
      result.status.toLowerCase() === "failed" ||
      result.status.toLowerCase() === "error"
    ) {
      throw new Error(result.errorMessage || "Image generation failed");
    }
    if (!result.resultUrl) throw new Error("No result URL from image task");

    onProgress?.(92, "downloading");
    try {
      const saved = await saveMedia(result.resultUrl);
      onProgress?.(100, "done");
      return { url: saved.localPath };
    } catch {
      onProgress?.(100, "done");
      return { url: result.resultUrl };
    }
  }

  const img = data.data?.[0];
  if (!img?.url) throw new Error("No image returned");

  onProgress?.(92, "downloading");
  try {
    const saved = await saveMedia(img.url);
    onProgress?.(100, "done");
    return { url: saved.localPath, revisedPrompt: img.revised_prompt };
  } catch {
    onProgress?.(100, "done");
    return { url: img.url, revisedPrompt: img.revised_prompt };
  }
}

// ── Video generation ────────────────────────────────────────

export async function generateVideo(
  prompt: string,
  model?: string,
  onProgress?: (progress: number, status: string) => void,
): Promise<{ url: string }> {
  const body: Record<string, unknown> = {
    model: model ?? "veo3.1-fast",
    prompt,
  };

  onProgress?.(0, "submitting");

  const raw = await aiProxy("openai", "/v2/videos/generations", body);
  if (raw.status >= 400) {
    throw new Error(`Video generation failed (HTTP ${raw.status}): ${raw.body}`);
  }

  const data = JSON.parse(raw.body);
  const taskIdMatch = raw.body.match(/"task_id"\s*:\s*(\d+)/);
  if (data.task_id || taskIdMatch) {
    const taskId = taskIdMatch ? taskIdMatch[1]! : String(data.task_id);
    onProgress?.(5, "queued");
    const result = await waitForTask(taskId, (progress, status) => {
      onProgress?.(Math.max(5, Math.min(90, progress)), status);
    });
    if (
      result.status.toLowerCase() === "failed" ||
      result.status.toLowerCase() === "error"
    ) {
      throw new Error(result.errorMessage || "Video generation failed");
    }
    if (!result.resultUrl) throw new Error("No result URL from video task");

    onProgress?.(92, "downloading");
    try {
      const saved = await saveMedia(result.resultUrl);
      onProgress?.(100, "done");
      return { url: saved.localPath };
    } catch {
      onProgress?.(100, "done");
      return { url: result.resultUrl };
    }
  }

  throw new Error("No task_id in video generation response");
}

// ── Auto-title generation ───────────────────────────────────

export async function generateTitle(
  firstUserMessage: string,
  model: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "system",
        content:
          "Generate a very short title (max 10 Chinese characters or 6 English words) for this conversation. Output ONLY the title, no quotes, no explanation.",
      },
      { role: "user", content: firstUserMessage },
    ],
    max_tokens: 30,
  };

  const raw = await aiProxy("openai", "/v1/chat/completions", body);
  if (raw.status >= 400) return "新对话";

  try {
    const data = JSON.parse(raw.body);
    let title = data.choices?.[0]?.message?.content?.trim() ?? "";
    title = title.replace(/^["'"""'']+|["'"""'']+$/g, "").trim();
    if (title.length > 20) title = title.slice(0, 20);
    return title || "新对话";
  } catch {
    return "新对话";
  }
}
