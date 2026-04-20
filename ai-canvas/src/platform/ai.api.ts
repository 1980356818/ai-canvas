import type { AiProxyResponse, StreamCallbacks, ModelInfo, TaskInfo } from "@/types";
import { isTauri, ensureTauriAPIs, getInvoke, getListen } from "./runtime";
import { buildProxyUrl, getAuthHeaders } from "./storage";

const DEBUG = import.meta.env.DEV;

export async function aiProxy(
  provider: string,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<AiProxyResponse> {
  if (isTauri) {
    await ensureTauriAPIs();
    return getInvoke()<AiProxyResponse>("ai_proxy", { provider, endpoint, body });
  }

  const url = buildProxyUrl(endpoint, provider);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...getAuthHeaders(),
  };

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  return { body: text, status: resp.status };
}

export async function aiProxyStream(
  provider: string,
  endpoint: string,
  body: Record<string, unknown>,
  callbacks: StreamCallbacks,
): Promise<{ streamId: string; abort: () => Promise<void> }> {
  const streamId = crypto.randomUUID();

  if (isTauri) {
    await ensureTauriAPIs();

    interface StreamEvent {
      stream_id: string;
      event: "chunk" | "done" | "error";
      data: string;
    }

    const unlisten = await getListen()<StreamEvent>("ai-stream", (event) => {
      const payload = event.payload;
      if (payload.stream_id !== streamId) return;
      switch (payload.event) {
        case "chunk":
          callbacks.onChunk(payload.data);
          break;
        case "done":
          callbacks.onDone();
          unlisten();
          break;
        case "error":
          console.error("[Stream][Tauri] error:", payload.data.slice(0, 500));
          callbacks.onError(payload.data);
          break;
      }
    });

    await getInvoke()("ai_proxy_stream", {
      provider,
      endpoint,
      body: { ...body, stream: true },
      streamId,
    });

    return {
      streamId,
      abort: async () => {
        await getInvoke()("ai_proxy_stream_abort", { streamId });
        unlisten();
      },
    };
  }

  const abortController = new AbortController();
  const url = buildProxyUrl(endpoint, provider);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...getAuthHeaders(),
  };

  (async () => {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, stream: true }),
        signal: abortController.signal,
      });

      if (!resp.ok) {
        const errText = await resp.text();
        callbacks.onError(`HTTP ${resp.status}: ${errText}`);
        return;
      }

      const reader = resp.body?.getReader();
      if (!reader) {
        callbacks.onError("No readable stream");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;
          if (trimmed === "data: [DONE]") {
            callbacks.onDone();
            return;
          }
          if (trimmed.startsWith("data: ")) {
            callbacks.onChunk(trimmed.slice(6));
          }
        }
      }

      callbacks.onDone();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error("[Stream][Browser] fetch error:", err);
        callbacks.onError(err instanceof Error ? err.message : String(err));
      }
    }
  })();

  return {
    streamId,
    abort: async () => {
      abortController.abort();
    },
  };
}

// ── Gateway ─────────────────────────────────────────────────

export async function listModels(provider?: string): Promise<ModelInfo[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    const raw = await getInvoke()<{ data?: ModelInfo[] }>("list_models", { provider });
    return raw.data ?? [];
  }

  const url = buildProxyUrl("/v1/models", provider);
  const resp = await fetch(url, { headers: getAuthHeaders() });
  if (!resp.ok) throw new Error(`Failed to list models: ${resp.status}`);
  const data = await resp.json();
  return data.data ?? [];
}

function extractNestedUrl(raw: Record<string, unknown>): string | undefined {
  const output = raw.output as Record<string, unknown> | undefined;
  if (output) {
    return (output.video_url ?? output.result_url ?? output.url) as string | undefined;
  }
  const content = raw.content as Record<string, unknown> | undefined;
  if (content) {
    return (content.video_url ?? content.url) as string | undefined;
  }
  return undefined;
}

function parseFirstUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === "string") {
        return arr[0];
      }
    } catch { /* not JSON, use as-is */ }
  }
  return trimmed;
}

export function normalizeTaskInfo(raw: Record<string, unknown>): TaskInfo {
  if (DEBUG) {
    console.log("[TaskPoll] raw fields:", Object.keys(raw));
  }
  const rawUrl = (raw.resultUrl ?? raw.result_url ?? raw.video_url ?? extractNestedUrl(raw)) as string | undefined;
  const info: TaskInfo = {
    id: String(raw.id ?? ""),
    status: String(raw.status ?? ""),
    progress: Number(raw.progress ?? 0),
    resultUrl: parseFirstUrl(rawUrl),
    thumbnailUrl: (raw.thumbnailUrl ?? raw.thumbnail_url) as string | undefined,
    errorMessage: (raw.errorMessage ?? raw.error_message ?? raw.error_msg) as string | undefined,
    createdAt: (raw.createdAt ?? raw.created_at) as string | undefined,
    finishedAt: (raw.finishedAt ?? raw.finished_at) as string | undefined,
  };
  return info;
}

export async function pollTask(taskId: string, endpoint?: string, provider?: string): Promise<TaskInfo> {
  if (isTauri) {
    await ensureTauriAPIs();
    const raw = await getInvoke()<Record<string, unknown>>("poll_task", { taskId, endpoint, provider });
    return normalizeTaskInfo(raw);
  }

  const path = endpoint
    ? endpoint.replace("{task_id}", taskId)
    : `/v1/tasks/${taskId}`;
  const url = buildProxyUrl(path, provider);
  const resp = await fetch(url, { headers: getAuthHeaders() });
  if (!resp.ok) throw new Error(`Failed to poll task: ${resp.status}`);
  const raw = await resp.json();
  return normalizeTaskInfo(raw);
}

export async function validateConnection(provider?: string): Promise<boolean> {
  if (isTauri) {
    await ensureTauriAPIs();
    return getInvoke()<boolean>("validate_connection", { provider });
  }

  const url = buildProxyUrl("/v1/models", provider);
  const resp = await fetch(url, { headers: getAuthHeaders() });
  if (!resp.ok)
    throw new Error(`连接失败: HTTP ${resp.status}`);
  return true;
}
