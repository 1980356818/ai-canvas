import type { AiProxyResponse, StreamCallbacks, ModelInfo, TaskInfo } from "@/types";
import { isTauri, ensureTauriAPIs, getInvoke, getListen } from "./runtime";
import { diagError, diagWarn } from "@/lib/diag";

// 跨次流式调用累计的"活监听器"计数。监听器泄漏是历史 bug 的根源
// (done/error/onDone 抛错时旧实现会漏 unlisten),现在每个 stream 都进/出
// 这个 Set,diag 通过它能在出错时拉到现场。
const _activeStreamListeners = new Set<string>();

// ── Tauri-only 守门 ──────────────────────────────────────────────────────
//
// ai-canvas 是 Tauri 桌面应用, 前端**不允许**直接发出站 HTTP 请求 (CORS /
// cookie / mixed-content 等浏览器层风险, 2026-05-30 CORS 事件根治结论)。
// 历史 Web 模式分支 (浏览器原生 fetch 直连 provider) 已全部移除, 这里加 guard
// 防止"哪天有人重新引入" —— 调用方在非 Tauri 环境下立刻报错而不是静默 fetch。
//
// 走 Rust invoke 的入口:
//   ai_proxy / ai_proxy_stream / ai_proxy_stream_abort  → AI 模型 API
//   list_models / poll_task / validate_connection       → gateway
//   http_request                                         → 通用上行 (见 httpAdapter)
function requireTauri(fn: string): void {
  if (!isTauri) {
    throw new Error(
      `[ai.api] ${fn} 仅支持 Tauri 环境。前端不允许在 Web 上直接调 AI API (规约: 详见 src/platform/httpAdapter.ts 顶部注释)。`,
    );
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
  requireTauri("aiProxy");
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

export async function aiProxyStream(
  provider: string,
  endpoint: string,
  body: Record<string, unknown>,
  callbacks: StreamCallbacks,
): Promise<{ streamId: string; abort: () => Promise<void> }> {
  requireTauri("aiProxyStream");
  const streamId = crypto.randomUUID();

  await ensureTauriAPIs();

  interface StreamEvent {
    stream_id: string;
    event: "chunk" | "done" | "error" | "key_switched";
    data: string;
  }

  // ── 统一 cleanup:done / error / abort / 用户回调抛错都走这里。
  // 旧版只在 done 分支调 unlisten,error 路径直接漏;连发几次生成就攒一堆
  // 监听器,每个 chunk 触发 N 个回调,最终 WebView 渲染进程 OOM 白屏。
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

    // 用户回调抛错不能影响 cleanup —— 全部包 try/catch,错误转交 diag。
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

  // 后端 invoke 失败也要 cleanup,否则监听器永远挂着
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

// ── Gateway ─────────────────────────────────────────────────

export async function listModels(provider?: string): Promise<ModelInfo[]> {
  requireTauri("listModels");
  await ensureTauriAPIs();
  const raw = await getInvoke()<{ data?: ModelInfo[] }>("list_models", { provider });
  return raw.data ?? [];
}

/** /v1/models 模型条目里携带的价格字段(ModelInfo 未声明,但 runtime 实有)。 */
export interface RawPriceModel {
  id: string;
  display_name?: string | null;
  capability?: string | null;
  cost_per_request?: number | null;
  cost_per_second?: number | null;
  input_cost_per_1m?: number | null;
  output_cost_per_1m?: number | null;
  lines?: Array<{ tag?: string | null; cost_type?: string | null }> | null;
}

/**
 * 拉取极境模型列表(含价格字段),价格表专用。
 *
 * 复用 gateway 的 `list_models`(GET /v1/models,**不传 platform=全量**,覆盖所有
 * SKU),返回原样 JSON —— 价格字段 runtime 已在,只是 listModels() 的 ModelInfo
 * 类型未声明。零 Rust 改动。
 */
export async function listModelsWithPricing(provider = "jijing"): Promise<RawPriceModel[]> {
  requireTauri("listModelsWithPricing");
  await ensureTauriAPIs();
  const raw = await getInvoke()<{ data?: RawPriceModel[] }>("list_models", { provider });
  return raw.data ?? [];
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
 * 设计要点:**"没给进度"和"进度真的是 0"必须区分开**——后端经常返回
 * `progress: null` / 字段缺失 / `progress: 0`(用作占位),如果都塌缩成数字 0,
 * 客户端就拿不到"该用时间外推"的信号,UI 会卡死在 0%。
 *
 * 规则:
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

/** 从数组里取第一个非空 URL。极境成功响应有时只填 resultUrls(复数),resultUrl 留空。 */
function firstUrlFromArray(v: unknown): string | undefined {
  if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item === "string" && item.trim()) return item.trim();
    }
  }
  return undefined;
}

export function normalizeTaskInfo(raw: Record<string, unknown>): TaskInfo {
  if (import.meta.env.DEV) {
    console.log("[TaskPoll] raw fields:", Object.keys(raw));
  }
  const rawUrl = (raw.resultUrl
    ?? raw.result_url
    ?? raw.video_url
    ?? firstUrlFromArray(raw.resultUrls)
    ?? firstUrlFromArray(raw.result_urls)
    ?? extractNestedUrl(raw)) as string | undefined;
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
  requireTauri("pollTask");
  await ensureTauriAPIs();
  const raw = await getInvoke()<Record<string, unknown>>("poll_task", { taskId, endpoint, provider, keyTag });
  return normalizeTaskInfo(raw);
}

export interface ValidateConnectionOverrides {
  /** 当前表单里填写的 key (未保存),优先于数据库中的值。 */
  apiKey?: string;
  /** 当前表单里填写的 base URL (未保存),优先于数据库中的值。 */
  baseUrl?: string;
  /** 可选 key 槽位 (comfly: "default" / "gemini_premium");用于按槽位测试连接。 */
  keyTag?: string;
}

export async function validateConnection(
  provider?: string,
  overrides?: ValidateConnectionOverrides,
): Promise<boolean> {
  requireTauri("validateConnection");
  await ensureTauriAPIs();
  return getInvoke()<boolean>("validate_connection", {
    provider,
    apiKey: overrides?.apiKey,
    baseUrl: overrides?.baseUrl,
    keyTag: overrides?.keyTag,
  });
}
