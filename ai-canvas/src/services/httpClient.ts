/**
 * 统一 HTTP 客户端 —— 所有出网请求都经过这里。
 *
 * 它做两件事：
 *   1. 把 `aiProxy()` 的各种异常（网络/HTTP 状态/解析失败）规范化成 `TaskError`
 *   2. 在 transient 错误（network / timeout / 5xx）上做指数退避重试
 *
 * 不做的事：
 *   - 业务层的"任务级"重试 —— 那是 TaskManager 的活
 *   - 轮询循环 —— TaskManager 用本客户端实现轮询
 *
 * 错误分类的判定依据 `TaskError.kind`：
 *   - network     底层 fetch 失败（DNS / 连接 reset / 离线）
 *   - timeout     请求超时（前端给的 AbortSignal 触发）
 *   - server_5xx  HTTP 5xx
 *   - client_4xx  HTTP 4xx
 *   - business_failed 服务端 2xx 但业务标记失败
 *   - parse       响应不是合法 JSON
 */

import { aiProxy } from "@/platform";
import type { AiProxyResponse } from "@/types";
import type { TaskErrorKind } from "@/types";
import { TRANSIENT_ERROR_KINDS } from "@/types";

export class TaskError extends Error {
  readonly kind: TaskErrorKind;
  readonly status?: number;
  readonly body?: string;
  readonly cause?: unknown;

  constructor(
    kind: TaskErrorKind,
    message: string,
    extra?: { status?: number; body?: string; cause?: unknown },
  ) {
    super(message);
    this.name = "TaskError";
    this.kind = kind;
    this.status = extra?.status;
    this.body = extra?.body;
    this.cause = extra?.cause;
  }

  get isTransient(): boolean {
    return TRANSIENT_ERROR_KINDS.has(this.kind);
  }
}

export interface HttpRequestOpts {
  provider: string;
  endpoint: string;
  body: Record<string, unknown>;
  /** 调用方传 AbortSignal 来取消（例如用户点取消按钮）。 */
  signal?: AbortSignal;
  /** 单次请求超时；默认 60s（提交媒体生成接口偶尔慢）。 */
  timeoutMs?: number;
  /** 自动重试次数；默认 2（即最多发 3 次）。设为 0 关闭。 */
  maxTransientRetries?: number;
}

/**
 * 发起一次 JSON 请求，返回解析后的对象，或抛出 `TaskError`。
 *
 * 对 transient 错误（network / timeout / 5xx）做最多 `maxTransientRetries` 次指数退避；
 * permanent 错误（4xx / business / parse）立即抛出不重试。
 */
export async function httpJsonRequest<T = Record<string, unknown>>(
  opts: HttpRequestOpts,
): Promise<T> {
  const maxRetries = opts.maxTransientRetries ?? 2;
  let attempt = 0;

  while (true) {
    if (opts.signal?.aborted) {
      throw new TaskError("network", "request canceled before send");
    }

    try {
      return await sendOnce<T>(opts);
    } catch (err) {
      const taskErr = err instanceof TaskError
        ? err
        : new TaskError("network", String((err as Error)?.message ?? err), { cause: err });

      if (!taskErr.isTransient || attempt >= maxRetries) {
        throw taskErr;
      }

      // 指数退避：500ms → 2s → 8s
      const delay = 500 * Math.pow(4, attempt);
      attempt += 1;
      await sleepCancelable(delay, opts.signal);
    }
  }
}

async function sendOnce<T>(opts: HttpRequestOpts): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 60_000;

  // aiProxy 自己不支持 AbortSignal（Tauri invoke 没法中途断），
  // 所以这里实现"前端层超时"，但请求本身可能还在跑。
  // 真正的取消依赖 TaskManager 上层判断 signal 后丢弃结果。
  const proxyPromise = invokeProxyWithClassification(opts);
  const resp = await raceWithTimeoutAndSignal(
    proxyPromise,
    timeoutMs,
    opts.signal,
    () => new TaskError("timeout", `request timeout after ${timeoutMs}ms`),
    () => new TaskError("network", "request canceled"),
  );
  return parseAndValidate<T>(resp);
}

async function invokeProxyWithClassification(
  opts: HttpRequestOpts,
): Promise<AiProxyResponse> {
  try {
    return await aiProxy(opts.provider, opts.endpoint, opts.body);
  } catch (err) {
    // Tauri 的 ai_proxy 把 reqwest 错误转成 String 抛出。常见模式：
    //   "EOF during handshake" / "broken pipe" / "connection reset"
    //   "dns error" / "network is unreachable"
    //   "operation timed out"
    const msg = String((err as Error)?.message ?? err);
    const kind = classifyNativeError(msg);
    throw new TaskError(kind, msg, { cause: err });
  }
}

function classifyNativeError(msg: string): TaskErrorKind {
  const lower = msg.toLowerCase();
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("deadline exceeded")
  ) {
    return "timeout";
  }
  // 默认 network —— 包括 DNS / connect / EOF / reset / broken pipe / 离线
  return "network";
}

function parseAndValidate<T>(resp: AiProxyResponse): T {
  const { status, body } = resp;

  if (status >= 500) {
    throw new TaskError("server_5xx", `HTTP ${status}`, { status, body });
  }
  if (status >= 400) {
    throw new TaskError("client_4xx", `HTTP ${status}: ${truncate(body, 200)}`, {
      status,
      body,
    });
  }

  // 2xx：尝试解析 JSON
  try {
    const parsed = body ? JSON.parse(body) : {};
    return parsed as T;
  } catch (err) {
    throw new TaskError("parse", "response is not valid JSON", {
      status,
      body,
      cause: err,
    });
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "...";
}

async function sleepCancelable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(id);
      signal?.removeEventListener("abort", onAbort);
      reject(new TaskError("network", "sleep canceled"));
    };
    const id = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);
  });
}

/**
 * 用 timeout + 外部 AbortSignal 包装 Promise，保证 race 出胜者后**立即**清理
 * setTimeout 和 signal listener。直接 `Promise.race` 的写法会让赢家之外的定时器
 * 和监听器残留——长任务 / 频繁调用会累积成 OOM 隐患。
 *
 * - `buildTimeoutError`：超时触发时构造抛出的 Error
 * - `buildAbortError`：signal abort 触发时构造抛出的 Error
 * - 若 signal 在调用前已 aborted，直接抛 abort error，不启 timer
 */
function raceWithTimeoutAndSignal<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  buildTimeoutError: () => Error,
  buildAbortError: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(buildAbortError());
    };

    const cleanup = () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(buildTimeoutError());
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort);

    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      },
    );
  });
}
