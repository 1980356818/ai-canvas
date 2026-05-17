/**
 * 通用媒体任务 Handler 工厂。
 *
 * 把"POST → 提取 task_id → 轮询 → 下载"这条通用流水线封装成一个 TaskHandler，
 * 让所有 provider（comfly / jijing / seedance / custom / ...）共享同一实现，
 * 各自只通过参数差异化（trySyncResult / kind 标签）。
 *
 * 注册时机：每个 provider 在被 `registry.register()` 之前/后立刻调用
 * `registerMediaHandlers(providerId, opts)` 一次性把 image_gen / video_gen / audio_gen
 * 三种 kind 全部注册。重复注册是幂等的，覆盖即可。
 *
 * 与 TaskManager 的契约：
 *   - submit() 抛 TaskError —— TaskManager 据此判断 transient/permanent
 *   - poll() 返回 PollOutcome —— pending 继续，success/failed 终态
 *   - finalize() 把远端 URL 下载到本地，失败兜底返回远端
 */

import { aiProxy, pollTask, saveMedia } from "@/platform";
import { TaskError } from "@/services/httpClient";
import {
  taskManager,
  type TaskHandler,
  type SubmitOutcome,
  type PollOutcome,
  type TaskCtx,
} from "@/services/taskManager";

export interface MediaHandlerOptions {
  /**
   * 同步快路径：图像 API 偶尔会直接返回 URL（如 OpenAI `data[0].url`）。
   * 返回非 null 时跳过轮询直接进入 finalize；返回 null 走 task_id 异步路径。
   */
  trySyncResult?: (data: unknown) => { url: string; revisedPrompt?: string } | null;
}

/**
 * 注册某个 provider 的三种媒体 kind handler。
 *
 * 把 image_gen / video_gen / audio_gen 三种 kind 全注册成同一份逻辑 —— 它们的
 * "提交 / 轮询 / 下载"流程并无差异，差异在于 `submit_endpoint` 与 `request`，
 * 这两者都由调用方在 TaskSpec 里传进来，handler 不区分 kind。
 */
export function registerMediaHandlers(
  providerId: string,
  opts: MediaHandlerOptions = {},
): void {
  const handler = createMediaTaskHandler(opts);
  taskManager.registerHandler(providerId, "image_gen", handler);
  taskManager.registerHandler(providerId, "video_gen", handler);
  taskManager.registerHandler(providerId, "audio_gen", handler);
}

export function createMediaTaskHandler(
  opts: MediaHandlerOptions = {},
): TaskHandler {
  return {
    submit: (request, ctx) => submitMedia(request, ctx, opts),
    poll: (externalId, ctx) => pollMedia(externalId, ctx),
    finalize: (rawResult, ctx) => finalizeMedia(rawResult, ctx),
  };
}

// ────────────────────────────────────────────────────────────────
// submit：POST 请求体到 submit_endpoint，提取 task_id（或同步直返 URL）
// ────────────────────────────────────────────────────────────────

async function submitMedia(
  request: Record<string, unknown>,
  ctx: TaskCtx,
  opts: MediaHandlerOptions,
): Promise<SubmitOutcome> {
  const task = ctx.task;

  let raw;
  try {
    raw = await aiProxy(task.provider, task.submitEndpoint, request);
  } catch (err) {
    throw classifyNative(err);
  }

  if (raw.status >= 500) {
    throw new TaskError("server_5xx", `HTTP ${raw.status}: ${truncate(raw.body, 200)}`, {
      status: raw.status,
      body: raw.body,
    });
  }
  if (raw.status >= 400) {
    throw new TaskError("client_4xx", `HTTP ${raw.status}: ${truncate(raw.body, 200)}`, {
      status: raw.status,
      body: raw.body,
    });
  }

  let data: unknown;
  try {
    data = raw.body ? JSON.parse(raw.body) : {};
  } catch (err) {
    throw new TaskError("parse", "submit response is not valid JSON", {
      body: raw.body,
      cause: err,
    });
  }

  // 同步快路径（OpenAI 兼容图像 API 等）
  if (opts.trySyncResult) {
    const sync = opts.trySyncResult(data);
    if (sync) {
      return { mode: "sync", result: { ...sync } };
    }
  }

  // 异步：提取 task_id（用 raw body 的 regex 保 Snowflake 精度）
  const externalId = extractTaskId(raw.body, data);
  if (!externalId) {
    throw new TaskError("parse", "failed to extract task_id from submit response", {
      body: raw.body,
    });
  }

  return { mode: "async", externalTaskId: externalId };
}

const TASK_ID_REGEX = /"task_id"\s*:\s*"?(\d+)"?/;

function extractTaskId(rawBody: string, data: unknown): string | null {
  // 优先 regex —— JSON.parse 会把大数字段精度损失，task_id 经常是 Snowflake
  const match = rawBody.match(TASK_ID_REGEX);
  if (match) return match[1]!;

  const d = data as
    | { task_id?: unknown; id?: unknown; data?: { task_id?: unknown; id?: unknown } }
    | null
    | undefined;
  if (!d) return null;
  if (d.task_id != null) return String(d.task_id);
  if (d.id != null) return String(d.id);
  if (d.data?.task_id != null) return String(d.data.task_id);
  if (d.data?.id != null) return String(d.data.id);
  return null;
}

// ────────────────────────────────────────────────────────────────
// poll：用 external_id 查询状态
// ────────────────────────────────────────────────────────────────

const POLL_SUCCESS = new Set(["completed", "success", "succeeded"]);
const POLL_FAILED = new Set(["failed", "error", "cancelled", "canceled", "expired"]);

async function pollMedia(
  externalId: string,
  ctx: TaskCtx,
): Promise<PollOutcome> {
  const task = ctx.task;

  let info;
  try {
    info = await pollTask(
      externalId,
      task.pollEndpoint ?? undefined,
      task.provider,
      task.keyTag ?? undefined,
    );
  } catch (err) {
    // pollTask 抛裸 Error("Failed to poll task: <status>")；翻译成 TaskError
    throw classifyPollError(err);
  }

  const status = (info.status || "").toLowerCase();

  if (POLL_SUCCESS.has(status)) {
    if (!info.resultUrl) {
      return { status: "failed", message: "任务完成但未返回结果地址" };
    }
    return {
      status: "success",
      result: {
        url: info.resultUrl,
        thumbnailUrl: info.thumbnailUrl,
      },
    };
  }

  if (POLL_FAILED.has(status)) {
    return { status: "failed", message: info.errorMessage || "任务失败" };
  }

  return { status: "pending", progress: info.progress };
}

// ────────────────────────────────────────────────────────────────
// finalize：把远端 URL 下载到本地
// ────────────────────────────────────────────────────────────────

async function finalizeMedia(
  rawResult: Record<string, unknown>,
  ctx: TaskCtx,
): Promise<Record<string, unknown>> {
  const task = ctx.task;
  const url = typeof rawResult.url === "string" ? rawResult.url : undefined;
  const revisedPrompt =
    typeof rawResult.revisedPrompt === "string" ? rawResult.revisedPrompt : undefined;

  if (!url) return rawResult;

  // title 用 prompt 的前 80 字（如果有）作为文件名提示
  const promptHint =
    typeof task.request.prompt === "string"
      ? (task.request.prompt as string).slice(0, 80)
      : undefined;

  try {
    const saved = await saveMedia(url, undefined, promptHint, task.projectId);
    return {
      url: saved.localPath,
      remoteUrl: url,
      ...(revisedPrompt != null ? { revisedPrompt } : {}),
    };
  } catch (err) {
    // 本地保存失败：仍认为任务成功，返回远端 URL 作为兜底
    console.warn("[mediaHandler] saveMedia failed, fallback to remote url:", err);
    return {
      url,
      remoteUrl: url,
      ...(revisedPrompt != null ? { revisedPrompt } : {}),
      saveError: true,
    };
  }
}

// ────────────────────────────────────────────────────────────────
// 工具
// ────────────────────────────────────────────────────────────────

function classifyNative(err: unknown): TaskError {
  if (err instanceof TaskError) return err;
  const msg = String((err as Error)?.message ?? err);
  const lower = msg.toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout") || lower.includes("deadline")) {
    return new TaskError("timeout", msg, { cause: err });
  }
  return new TaskError("network", msg, { cause: err });
}

function classifyPollError(err: unknown): TaskError {
  if (err instanceof TaskError) return err;
  const msg = String((err as Error)?.message ?? err);
  // 三种已知格式：
  //   Rust  gateway::poll_task : "查询任务失败 (HTTP 404): ..."
  //   JS  浏览器降级 fetch       : "Failed to poll task: 404"
  //   reqwest 直接抛             : "... HTTP 500 ..."
  const m = msg.match(/HTTP\s+(\d{3})|poll task:\s*(\d{3})/i);
  if (m) {
    const status = Number(m[1] ?? m[2]);
    if (status >= 500) return new TaskError("server_5xx", msg, { status });
    if (status >= 400) return new TaskError("client_4xx", msg, { status });
  }
  return classifyNative(err);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "...";
}
