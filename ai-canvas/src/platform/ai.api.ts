import type { AiProxyResponse, StreamCallbacks, ModelInfo, TaskInfo } from "@/types";
import { isTauri, ensureTauriAPIs, getInvoke, getListen } from "./runtime";
import { buildProxyUrl, getProviderAuthHeaders, lsGet, lsSet } from "./storage";

const DEBUG = import.meta.env.DEV;

function isRetryableStatus(status: number): boolean {
  return status >= 400;
}

interface BrowserKeyEntry {
  id: string;
  name: string;
  key: string;
}

function getBrowserKeys(provider: string): BrowserKeyEntry[] {
  const prefix = provider === "comfly" ? "openai" : provider;
  const json = lsGet<string | null>(`setting_${provider}_api_keys`, null);
  if (json) {
    try {
      const parsed: BrowserKeyEntry[] = JSON.parse(json);
      return parsed.filter((k) => k.key.trim());
    } catch { /* ignore */ }
  }
  const legacy = lsGet<string | null>(`setting_${prefix}_api_key`, null);
  if (legacy?.trim()) {
    return [{ id: "legacy", name: "默认", key: legacy.trim() }];
  }
  return [];
}

function isBrowserAutoRotate(provider: string): boolean {
  return lsGet<string | null>(`setting_${provider}_auto_rotate`, null) !== "false";
}

function setBrowserActiveKey(provider: string, entry: BrowserKeyEntry) {
  lsSet(`setting_${provider}_active_key_id`, entry.id);
  lsSet(`setting_${provider}_api_key`, entry.key);
  if (provider === "comfly") {
    lsSet("setting_openai_api_key", entry.key);
  }
}

function notifyKeyRotation(keyName: string | null | undefined) {
  if (!keyName) return;
  try {
    const event = new CustomEvent("ai-key-rotated", { detail: { keyName } });
    window.dispatchEvent(event);
  } catch { /* safe to ignore in non-browser environments */ }
}

export async function aiProxy(
  provider: string,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<AiProxyResponse> {
  if (isTauri) {
    console.log("[platform.aiProxy] invoke ai_proxy start", {
      provider,
      endpoint,
      bodyKeys: Object.keys(body),
      debugRequestId: typeof body._debug_request_id === "string" ? body._debug_request_id : undefined,
    });
    const started = performance.now();
    await ensureTauriAPIs();
    const result = await getInvoke()<AiProxyResponse>("ai_proxy", { provider, endpoint, body });
    console.log("[platform.aiProxy] invoke ai_proxy returned", {
      provider,
      endpoint,
      status: result.status,
      elapsedMs: Math.round(performance.now() - started),
      bodyBytes: result.body.length,
      debugRequestId: typeof body._debug_request_id === "string" ? body._debug_request_id : undefined,
    });
    notifyKeyRotation(result.rotated_key_name);
    return result;
  }

  const url = buildProxyUrl(endpoint, provider);
  const keys = getBrowserKeys(provider);
  const canRotate = isBrowserAutoRotate(provider) && keys.length > 1;

  if (keys.length === 0) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...getProviderAuthHeaders(provider),
    };
    const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await resp.text();
    return { body: text, status: resp.status };
  }

  let lastBody = "";
  let lastStatus = 0;

  for (let i = 0; i < keys.length; i++) {
    const entry = keys[i]!;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${entry.key}`,
    };

    const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await resp.text();

    if (resp.status < 400 || !canRotate || !isRetryableStatus(resp.status)) {
      if (i > 0) {
        setBrowserActiveKey(provider, entry);
        notifyKeyRotation(entry.name);
      }
      return { body: text, status: resp.status, rotated_key_name: i > 0 ? entry.name : undefined, tried_count: i + 1 };
    }

    if (DEBUG) {
      console.warn(`[key_rotation][browser] key "${entry.name}" failed: HTTP ${resp.status}, rotating`);
    }
    lastBody = text;
    lastStatus = resp.status;
  }

  return { body: lastBody, status: lastStatus, tried_count: keys.length };
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
      event: "chunk" | "done" | "error" | "key_switched";
      data: string;
    }

    const unlisten = await getListen()<StreamEvent>("ai-stream", (event) => {
      const payload = event.payload;
      if (payload.stream_id !== streamId) return;
      switch (payload.event) {
        case "chunk":
          callbacks.onChunk(payload.data);
          break;
        case "key_switched": {
          try {
            const info = JSON.parse(payload.data);
            notifyKeyRotation(info.key_name);
            callbacks.onKeySwitched?.(info.key_name, info.tried_count);
          } catch { /* ignore parse error */ }
          break;
        }
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
  const keys = getBrowserKeys(provider);
  const canRotate = isBrowserAutoRotate(provider) && keys.length > 1;

  (async () => {
    const tryStreamWithKey = async (apiKey: string): Promise<{ ok: boolean; retryable: boolean }> => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: apiKey ? `Bearer ${apiKey}` : "",
      };

      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, stream: true }),
        signal: abortController.signal,
      });

      if (!resp.ok) {
        const errText = await resp.text();
        const retryable = isRetryableStatus(resp.status);
        if (!retryable) {
          callbacks.onError(`HTTP ${resp.status}: ${errText}`);
        }
        return { ok: false, retryable };
      }

      const reader = resp.body?.getReader();
      if (!reader) {
        callbacks.onError("No readable stream");
        return { ok: false, retryable: false };
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
            return { ok: true, retryable: false };
          }
          if (trimmed.startsWith("data: ")) {
            callbacks.onChunk(trimmed.slice(6));
          }
        }
      }

      callbacks.onDone();
      return { ok: true, retryable: false };
    };

    try {
      if (keys.length === 0) {
        const h = getProviderAuthHeaders(provider);
        const apiKey = h.Authorization?.replace("Bearer ", "") ?? "";
        await tryStreamWithKey(apiKey);
        return;
      }

      for (let i = 0; i < keys.length; i++) {
        const entry = keys[i]!;
        const result = await tryStreamWithKey(entry.key);

        if (result.ok) {
          if (i > 0) {
            setBrowserActiveKey(provider, entry);
            notifyKeyRotation(entry.name);
            callbacks.onKeySwitched?.(entry.name, i + 1);
          }
          return;
        }

        if (!result.retryable || !canRotate) return;

        if (DEBUG) {
          console.warn(`[key_rotation][browser][stream] key "${entry.name}" failed, rotating`);
        }
      }

      callbacks.onError(`所有 API Key 均不可用 (尝试了 ${keys.length} 个)`);
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
  const resp = await fetch(url, { headers: getProviderAuthHeaders(provider) });
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
  const resp = await fetch(url, { headers: getProviderAuthHeaders(provider) });
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
  const resp = await fetch(url, { headers: getProviderAuthHeaders(provider) });
  if (!resp.ok)
    throw new Error(`连接失败: HTTP ${resp.status}`);
  return true;
}
