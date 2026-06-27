/**
 * 异步任务的规范化类型。
 *
 * 之所以不复用 `task.ts` 的 `TaskInfo` —— `TaskInfo` 是"轮询接口的原始返回"，
 * 这里的 `AsyncTask` 是"我们自己持久化的任务记录"，两者寿命和职责完全不同。
 *
 * Rust 端对应：`src-tauri/src/commands/tasks.rs` 的 `TaskRow`
 */

/**
 * - queued     刚创建本地记录，未发起 submit
 * - submitting submit 请求在途
 * - polling    拿到 external_task_id 后的轮询阶段
 * - success    终态：拿到结果
 * - failed     终态：永久错误（4xx / 业务 failed / parse）
 * - canceled   终态：用户取消
 * - orphaned   终态：被重试/恢复流程标记为旧任务
 */
export type TaskStatus =
  | "queued"
  | "submitting"
  | "polling"
  | "success"
  | "failed"
  | "canceled"
  | "orphaned";

/**
 * 错误分类。前 3 类视为 transient（不打死卡片，继续退避），后 3 类是 permanent。
 */
export type TaskErrorKind =
  | "network"
  | "timeout"
  | "server_5xx"
  | "client_4xx"
  | "business_failed"
  | "parse";

export const TRANSIENT_ERROR_KINDS: ReadonlySet<TaskErrorKind> = new Set([
  "network",
  "timeout",
  "server_5xx",
]);

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "success",
  "failed",
  "canceled",
  "orphaned",
]);

export const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "queued",
  "submitting",
  "polling",
]);

/** SQLite 行格式（snake_case，与 Rust serde 一致） */
export interface AsyncTaskRow {
  id: string;
  card_id: string;
  project_id: string;
  provider: string;
  kind: string;
  submit_endpoint: string;
  poll_endpoint: string | null;
  external_task_id: string | null;
  status: TaskStatus;
  progress: number;
  request_payload: string;
  result_payload: string | null;
  error_kind: TaskErrorKind | null;
  error_message: string | null;
  key_tag: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
  last_polled_at: string | null;
  attempt_no: number;
  superseded_at: string | null;
}

/** 内存中的反序列化版本（camelCase，payload 已解析为对象） */
export interface AsyncTask {
  id: string;
  cardId: string;
  projectId: string;
  provider: string;
  kind: string;
  submitEndpoint: string;
  pollEndpoint?: string;
  externalTaskId?: string;
  status: TaskStatus;
  progress: number;
  request: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  errorKind?: TaskErrorKind;
  errorMessage?: string;
  keyTag?: string;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  lastPolledAt?: string;
  /** 该卡内尝试序号(1,2,3…)。新任务由 TaskManager.beginAttempt 赋值。 */
  attemptNo: number;
  /** 被「重新生成」替换的时刻;undefined = 当前尝试(唯一驱动画布卡)。 */
  supersededAt?: string;
}

export function rowToTask(row: AsyncTaskRow): AsyncTask {
  return {
    id: row.id,
    cardId: row.card_id,
    projectId: row.project_id,
    provider: row.provider,
    kind: row.kind,
    submitEndpoint: row.submit_endpoint,
    pollEndpoint: row.poll_endpoint ?? undefined,
    externalTaskId: row.external_task_id ?? undefined,
    status: row.status,
    progress: row.progress,
    request: safeParseJson(row.request_payload) ?? {},
    result: row.result_payload ? safeParseJson(row.result_payload) : null,
    errorKind: row.error_kind ?? undefined,
    errorMessage: row.error_message ?? undefined,
    keyTag: row.key_tag ?? undefined,
    retryCount: row.retry_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastPolledAt: row.last_polled_at ?? undefined,
    attemptNo: row.attempt_no ?? 1,
    supersededAt: row.superseded_at ?? undefined,
  };
}

export function taskToRow(task: AsyncTask): AsyncTaskRow {
  return {
    id: task.id,
    card_id: task.cardId,
    project_id: task.projectId,
    provider: task.provider,
    kind: task.kind,
    submit_endpoint: task.submitEndpoint,
    poll_endpoint: task.pollEndpoint ?? null,
    external_task_id: task.externalTaskId ?? null,
    status: task.status,
    progress: task.progress,
    request_payload: JSON.stringify(task.request),
    result_payload: task.result ? JSON.stringify(task.result) : null,
    error_kind: task.errorKind ?? null,
    error_message: task.errorMessage ?? null,
    key_tag: task.keyTag ?? null,
    retry_count: task.retryCount,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    last_polled_at: task.lastPolledAt ?? null,
    attempt_no: task.attemptNo ?? 1,
    superseded_at: task.supersededAt ?? null,
  };
}

function safeParseJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
