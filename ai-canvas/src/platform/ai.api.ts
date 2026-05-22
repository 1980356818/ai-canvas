import type { AiProxyResponse, StreamCallbacks, ModelInfo, TaskInfo } from "@/types";
import { isTauri, ensureTauriAPIs, getInvoke, getListen } from "./runtime";
import { buildProxyUrl, getProviderAuthHeaders, lsGet, lsSet } from "./storage";
import { getComflyKeyTag } from "@/providers/comfly/models";
import { diagError, diagWarn } from "@/lib/diag";

// 跨次流式调用累计的"活监听器"计数。监听器泄漏是历史 bug 的根源
// （done/error/onDone 抛错时旧实现会漏 unlisten），现在每个 stream 都进/出
// 这个 Set，diag 通过它能在出错时拉到现场。
const _activeStreamListeners = new Set<string>();

const DEBUG = import.meta.env.DEV;

function isRetryableStatus(status: number): boolean {
  return status >= 400;
}

interface BrowserKeyEntry {
  id: string;
  name: string;
  key: string;
  tag?: string;
}

/**
 * 根据 provider + 请求体派生 key 槽位 tag。
 * 仅 comfly 启用槽位路由；其他 provider 返回 undefined（不过滤）。
 */
function resolveKeyTag(provider: string, body: Record<string, unknown>): string | undefined {
  if (provider !== "comfly") return undefined;
  const model = typeof body.model === "string" ? body.model : undefined;
  return getComflyKeyTag(model);
}

function keyTagLabel(tag: string | undefined): string {
  if (tag === "gemini_premium") return "Gemini 优质";
  if (tag === "default") return "普通默认";
  return "";
}

function getBrowserKeys(provider: string, keyTag?: string): BrowserKeyEntry[] {
  const prefix = provider === "comfly" ? "openai" : provider;
  const json = lsGet<string | null>(`setting_${provider}_api_keys`, null);
  if (json) {
    try {
      const parsed: BrowserKeyEntry[] = JSON.parse(json);
      const filtered = keyTag
        ? parsed.filter((k) => (k.tag ?? "default") === keyTag)
        : parsed;
      return filtered.filter((k) => k.key.trim());
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
  const keyTag = resolveKeyTag(provider, body);
  const keys = getBrowserKeys(provider, keyTag);
  const canRotate = isBrowserAutoRotate(provider) && keys.length > 1;

  if (keys.length === 0) {
    const tagLabel = keyTagLabel(keyTag);
    if (tagLabel) {
      return {
        body: JSON.stringify({ error: { message: `Provider '${provider}' 的「${tagLabel}」槽位未配置 API Key，请在设置中填写` } }),
        status: 401,
      };
    }
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

    // ── 统一 cleanup：done / error / abort / 用户回调抛错都走这里。
    // 旧版只在 done 分支调 unlisten，error 路径直接漏；连发几次生成就攒一堆
    // 监听器，每个 chunk 触发 N 个回调，最终 WebView 渲染进程 OOM 白屏。
    let cleaned = false;
    let unlistenFn: (() => void) | null = null;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      _activeStreamListeners.delete(streamId);
      try {
        unlistenFn?.();
      } catch (err) {
        diagWarn("ai-stream", "unlisten failed", { streamId, err: String(err) });
      }
    };

    unlistenFn = await getListen()<StreamEvent>("ai-stream", (event) => {
      if (cleaned) return;
      const payload = event.payload;
      if (payload.stream_id !== streamId) return;

      // 用户回调抛错不能影响 cleanup —— 全部包 try/catch，错误转交 diag。
      try {
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
            try { callbacks.onDone(); } finally { cleanup(); }
            break;
          case "error":
            try { callbacks.onError(payload.data); } finally { cleanup(); }
            break;
        }
      } catch (err) {
        diagError("ai-stream", err, { streamId, event: payload.event });
        // 回调炸了照样要释放监听器
        cleanup();
      }
    });

    _activeStreamListeners.add(streamId);
    if (_activeStreamListeners.size > 8) {
      diagWarn("ai-stream", `${_activeStreamListeners.size} active listeners (possible leak)`, {
        ids: Array.from(_activeStreamListeners),
      });
    }

    // 后端 invoke 失败也要 cleanup，否则监听器永远挂着
    try {
      await getInvoke()("ai_proxy_stream", {
        provider,
        endpoint,
        body: { ...body, stream: true },
        streamId,
      });
    } catch (err) {
      cleanup();
      throw err;
    }

    return {
      streamId,
      abort: async () => {
        try {
          await getInvoke()("ai_proxy_stream_abort", { streamId });
        } finally {
          cleanup();
        }
      },
    };
  }

  const abortController = new AbortController();
  const url = buildProxyUrl(endpoint, provider);
  const keyTag = resolveKeyTag(provider, body);
  const keys = getBrowserKeys(provider, keyTag);
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

      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed !== "data: [DONE]" && trimmed.startsWith("data: ")) {
          callbacks.onChunk(trimmed.slice(6));
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
  // Comfly Veo: { data: { output: "https://..." } }
  const data = raw.data as Record<string, unknown> | undefined;
  if (data && typeof data.output === "string") {
    return data.output;
  }
  return undefined;
}

/**
 * 上游响应里的 progress 字段规范化。
 *
 * 设计要点：**"没给进度"和"进度真的是 0"必须区分开**——后端经常返回
 * `progress: null` / 字段缺失 / `progress: 0`（用作占位），如果都塌缩成数字 0，
 * 客户端就拿不到"该用时间外推"的信号，UI 会卡死在 0%。
 *
 * 规则：
 *   - null / undefined / 缺失   → undefined
 *   - 数字 > 0                  → 透传
 *   - 数字 <= 0 / NaN           → undefined
 *   - 字符串里抓到的数字 > 0    → 透传
 *   - 其他                      → undefined
 */
function parseProgressValue(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number") {
    return Number.isFinite(v) && v > 0 ? v : undefined;
  }
  if (typeof v === "string") {
    const m = v.match(/-?\d+(\.\d+)?/);
    if (m) {
      const n = Number(m[0]);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    }
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
    id: String(raw.id ?? raw.task_id ?? ""),
    status: String(raw.status ?? ""),
    progress: parseProgressValue(raw.progress),
    resultUrl: parseFirstUrl(rawUrl),
    thumbnailUrl: (raw.thumbnailUrl ?? raw.thumbnail_url) as string | undefined,
    errorMessage: (raw.errorMessage ?? raw.error_message ?? raw.error_msg ?? raw.fail_reason) as string | undefined,
    createdAt: (raw.createdAt ?? raw.created_at) as string | undefined,
    finishedAt: (raw.finishedAt ?? raw.finished_at) as string | undefined,
  };
  return info;
}

export async function pollTask(
  taskId: string,
  endpoint?: string,
  provider?: string,
  keyTag?: string,
): Promise<TaskInfo> {
  if (isTauri) {
    await ensureTauriAPIs();
    const raw = await getInvoke()<Record<string, unknown>>("poll_task", { taskId, endpoint, provider, keyTag });
    return normalizeTaskInfo(raw);
  }

  const path = endpoint
    ? endpoint.replace("{task_id}", taskId)
    : `/v1/tasks/${taskId}`;
  const url = buildProxyUrl(path, provider);
  const resp = await fetch(url, { headers: getProviderAuthHeaders(provider, keyTag) });
  if (!resp.ok) throw new Error(`Failed to poll task: ${resp.status}`);
  const raw = await resp.json();
  return normalizeTaskInfo(raw);
}

export interface ValidateConnectionOverrides {
  /** 当前表单里填写的 key（未保存），优先于数据库中的值。 */
  apiKey?: string;
  /** 当前表单里填写的 base URL（未保存），优先于数据库中的值。 */
  baseUrl?: string;
  /** 可选 key 槽位（comfly: "default" / "gemini_premium"）；用于按槽位测试连接。 */
  keyTag?: string;
}

export async function validateConnection(
  provider?: string,
  overrides?: ValidateConnectionOverrides,
): Promise<boolean> {
  if (isTauri) {
    await ensureTauriAPIs();
    return getInvoke()<boolean>("validate_connection", {
      provider,
      apiKey: overrides?.apiKey,
      baseUrl: overrides?.baseUrl,
      keyTag: overrides?.keyTag,
    });
  }

  const apiKey = overrides?.apiKey?.trim();
  const headers: Record<string, string> = apiKey
    ? { Authorization: `Bearer ${apiKey}` }
    : getProviderAuthHeaders(provider, overrides?.keyTag);
  const url = buildProxyUrl("/v1/models", provider);
  const resp = await fetch(url, { headers });
  if (!resp.ok)
    throw new Error(`连接失败: HTTP ${resp.status}`);
  return true;
}
