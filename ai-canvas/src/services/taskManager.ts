/**
 * TaskManager —— 异步任务的唯一入口和状态机引擎。
 *
 * 设计目标：
 *   1. 所有"提交 → 拿 external_task_id → 轮询 → 结果"型任务走同一条流水线
 *   2. 每次状态转换都先落库再触发副作用，崩溃/断网不丢任务
 *   3. 启动 / 切项目 / 网络恢复时可一次性 resume 所有未终止任务
 *   4. transient 错误（网络抖动）继续退避，permanent 错误才打死卡片
 *
 * 协作者：
 *   - httpClient.ts —— 出网，错误分类
 *   - tasksStore.ts —— 内存缓存 + 写穿到 SQLite
 *   - providers 实现 TaskHandler 注册到本管理器
 *
 * 不做的事：
 *   - UI 反馈（由 tasksStore 订阅驱动）
 *   - 媒体下载（由 handler 在 finalize 里调 saveMedia）
 */

import { useTasksStore } from "@/stores/tasksStore";
import { TaskError } from "./httpClient";
import type { AsyncTask, TaskErrorKind } from "@/types";
import { ACTIVE_STATUSES } from "@/types";

// ────────────────────────────────────────────────────────────────
// Handler 接口
// ────────────────────────────────────────────────────────────────

export interface TaskCtx {
  /** 当前任务快照（只读，最新状态见 store）。 */
  readonly task: AsyncTask;
  /** 上层取消信号。handler 内部所有出网请求都要传这个。 */
  readonly signal: AbortSignal;
  /** 轮询过程中上报进度（0-100），TaskManager 负责持久化。 */
  setProgress(p: number): void;
}

export type SubmitOutcome =
  | {
      /** 异步：服务器返回 task_id，需要后续轮询。 */
      mode: "async";
      externalTaskId: string;
      /** 覆盖 spec 中的 pollEndpoint（少数 provider 提交后才决定）。 */
      pollEndpointOverride?: string;
      /** 初始进度（默认 5）。 */
      initialProgress?: number;
    }
  | {
      /** 同步：提交即拿结果（直返图像 API）。 */
      mode: "sync";
      result: Record<string, unknown>;
    };

export type PollOutcome =
  | { status: "pending"; progress?: number }
  | { status: "success"; result: Record<string, unknown> }
  | { status: "failed"; message: string };

export interface TaskHandler {
  /** 必填：提交阶段。失败时抛 `TaskError`。 */
  submit(request: Record<string, unknown>, ctx: TaskCtx): Promise<SubmitOutcome>;

  /** 异步任务必填：轮询阶段。失败时抛 `TaskError`。 */
  poll?(externalTaskId: string, ctx: TaskCtx): Promise<PollOutcome>;

  /**
   * 可选：拿到原始 result 后的后处理（最常见用例：下载到本地）。
   * 返回值会替代 result 写入 DB；不抛错就是成功。
   */
  finalize?(
    rawResult: Record<string, unknown>,
    ctx: TaskCtx,
  ): Promise<Record<string, unknown>>;
}

// ────────────────────────────────────────────────────────────────
// 任务规格 & 内部状态
// ────────────────────────────────────────────────────────────────

export interface TaskSpec {
  cardId: string;
  projectId: string;
  provider: string;
  kind: string;
  submitEndpoint: string;
  pollEndpoint?: string;
  request: Record<string, unknown>;
  keyTag?: string;
}

interface RunningTask {
  controller: AbortController;
  promise: Promise<void>;
}

// ────────────────────────────────────────────────────────────────
// 轮询节流
// ────────────────────────────────────────────────────────────────

const POLL_INITIAL_DELAY = 1000;
const POLL_MAX_DELAY = 10_000;
const POLL_BACKOFF_FACTOR = 2;

/** 轮询遇到 transient 错误后的额外退避（不影响正常节奏）。 */
const TRANSIENT_RECOVERY_BASE = 2_000;
const TRANSIENT_RECOVERY_MAX = 30_000;

// ────────────────────────────────────────────────────────────────
// TaskManager
// ────────────────────────────────────────────────────────────────

class TaskManager {
  private handlers = new Map<string, TaskHandler>();
  private running = new Map<string, RunningTask>();

  /** 注册 handler，key = "provider:kind"。重复注册覆盖。 */
  registerHandler(provider: string, kind: string, handler: TaskHandler): void {
    this.handlers.set(handlerKey(provider, kind), handler);
  }

  hasHandler(provider: string, kind: string): boolean {
    return this.handlers.has(handlerKey(provider, kind));
  }

  /**
   * 创建并启动新任务。Promise 在终态（success/failed/canceled）时 resolve。
   * 上层只关心"我什么时候能拿到结果"，状态/进度通过 tasksStore 订阅。
   *
   * 想拿到 taskId 同步开始订阅、再异步等终态：用 `startTask()` 而非 `submit()`。
   */
  async submit(spec: TaskSpec): Promise<AsyncTask> {
    const { completion } = await this.startTask(spec);
    return completion;
  }

  /**
   * 落库新任务并在后台启动状态机；同步返回 taskId + 终态 Promise。
   *
   * 调用方拿到 taskId 后可立刻 subscribe tasksStore 观察进度，再 await completion
   * 拿最终结果。`submit()` 是它的语法糖（只关心终态时用）。
   */
  async startTask(
    spec: TaskSpec,
  ): Promise<{ taskId: string; completion: Promise<AsyncTask> }> {
    const handler = this.handlers.get(handlerKey(spec.provider, spec.kind));
    if (!handler) {
      throw new Error(
        `no handler registered for ${spec.provider}:${spec.kind}`,
      );
    }

    const now = new Date().toISOString();
    const task: AsyncTask = {
      id: crypto.randomUUID(),
      cardId: spec.cardId,
      projectId: spec.projectId,
      provider: spec.provider,
      kind: spec.kind,
      submitEndpoint: spec.submitEndpoint,
      pollEndpoint: spec.pollEndpoint,
      externalTaskId: undefined,
      status: "queued",
      progress: 0,
      request: spec.request,
      result: null,
      errorKind: undefined,
      errorMessage: undefined,
      keyTag: spec.keyTag,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
      lastPolledAt: undefined,
    };

    await useTasksStore.getState().upsert(task);
    const completion = this.run(task, handler);
    return { taskId: task.id, completion };
  }

  /**
   * 恢复某个未终止任务（启动/网络恢复时调）。
   * 如果该任务已经在内存里有 running entry，直接复用；否则按当前 DB 状态启动。
   */
  async resume(taskId: string): Promise<AsyncTask | null> {
    if (this.running.has(taskId)) {
      // 已经在跑，等它结束
      await this.running.get(taskId)!.promise;
      return useTasksStore.getState().getById(taskId) ?? null;
    }

    const task = useTasksStore.getState().getById(taskId);
    if (!task) {
      console.warn(`[TaskManager] resume: task ${taskId} not in store`);
      return null;
    }
    if (!ACTIVE_STATUSES.has(task.status)) {
      return task;
    }

    const handler = this.handlers.get(handlerKey(task.provider, task.kind));
    if (!handler) {
      // 没注册的 provider/kind —— 可能是开发分支删了，把任务标 failed 避免永远不前进
      await this.finalizeFailure(
        task,
        "parse",
        `no handler for ${task.provider}:${task.kind}`,
      );
      return useTasksStore.getState().getById(taskId) ?? null;
    }

    return await this.run(task, handler);
  }

  /** 批量恢复：列出 pending tasks → resume 每个。返回成功启动的数量。 */
  async resumeAll(projectId?: string): Promise<number> {
    const tasks = await useTasksStore.getState().hydratePending(projectId);
    let started = 0;
    for (const t of tasks) {
      if (this.running.has(t.id)) continue;
      this.resume(t.id).catch((err) => {
        console.error(`[TaskManager] resume ${t.id} failed:`, err);
      });
      started += 1;
    }
    return started;
  }

  /**
   * 取消一个正在跑的任务。已终止的任务调用是 no-op。
   * 注意：服务端任务不一定真的会停（取决于 provider），只是本地不再轮询。
   */
  async cancel(taskId: string): Promise<void> {
    const r = this.running.get(taskId);
    if (r) {
      r.controller.abort();
      // 等待 run() 把状态写为 canceled
      try {
        await r.promise;
      } catch {
        /* run() 自己处理状态，吞掉异常 */
      }
      return;
    }

    // 不在跑：直接落库为 canceled（如果还在 active 状态）
    const task = useTasksStore.getState().getById(taskId);
    if (!task || !ACTIVE_STATUSES.has(task.status)) return;
    await useTasksStore.getState().upsert({
      ...task,
      status: "canceled",
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * 重试：把旧任务标为 orphaned，用同样的 request 起一个新 task。
   * 老 result/error 保留在 orphaned 记录里供追溯。
   */
  async retry(taskId: string): Promise<AsyncTask> {
    const old = useTasksStore.getState().getById(taskId);
    if (!old) throw new Error(`task ${taskId} not found`);

    if (ACTIVE_STATUSES.has(old.status)) {
      await this.cancel(taskId);
    }

    await useTasksStore.getState().upsert({
      ...old,
      status: "orphaned",
      updatedAt: new Date().toISOString(),
    });

    return await this.submit({
      cardId: old.cardId,
      projectId: old.projectId,
      provider: old.provider,
      kind: old.kind,
      submitEndpoint: old.submitEndpoint,
      pollEndpoint: old.pollEndpoint,
      request: old.request,
      keyTag: old.keyTag,
    });
  }

  // ──────────────────────────────────────────────────────────────
  // 内部：状态机驱动
  // ──────────────────────────────────────────────────────────────

  private async run(task: AsyncTask, handler: TaskHandler): Promise<AsyncTask> {
    const controller = new AbortController();
    const promise = this.driveStateMachine(task.id, handler, controller.signal);
    this.running.set(task.id, { controller, promise });
    try {
      await promise;
    } finally {
      this.running.delete(task.id);
    }
    return useTasksStore.getState().getById(task.id) ?? task;
  }

  private async driveStateMachine(
    taskId: string,
    handler: TaskHandler,
    signal: AbortSignal,
  ): Promise<void> {
    let task = useTasksStore.getState().getById(taskId);
    if (!task) return;

    // submit phase（若任务已在 polling 阶段，跳过 submit 直接 poll）
    if (task.status !== "polling" || !task.externalTaskId) {
      task = await this.runSubmitPhase(task, handler, signal);
      if (!task || task.status !== "polling") return;
    }

    // poll phase
    if (!handler.poll) {
      await this.finalizeFailure(
        task,
        "parse",
        `provider ${task.provider}:${task.kind} returned async outcome but has no poll handler`,
      );
      return;
    }

    await this.runPollPhase(task, handler, signal);
  }

  private async runSubmitPhase(
    task: AsyncTask,
    handler: TaskHandler,
    signal: AbortSignal,
  ): Promise<AsyncTask | undefined> {
    await this.patch(task.id, { status: "submitting" });

    const ctx: TaskCtx = {
      task,
      signal,
      setProgress: (p) => {
        void this.patch(task.id, { progress: clampProgress(p) });
      },
    };

    try {
      const outcome = await handler.submit(task.request, ctx);

      if (outcome.mode === "sync") {
        await this.finalizeSuccess(task, outcome.result, handler, ctx);
        return undefined;
      }

      // async：拿到 external_id，进入 polling
      //
      // 注意：**不要**给 progress 写默认占位值——下游 taskBridge 和任务记录页都直接
      // 透传 task.progress，写占位值会让 UI 显示一个不存在的"假进度"。
      // 只在 provider 显式提供 initialProgress 时才写。
      const updated = await this.patch(task.id, {
        status: "polling",
        externalTaskId: outcome.externalTaskId,
        pollEndpoint:
          outcome.pollEndpointOverride ?? task.pollEndpoint ?? undefined,
        ...(outcome.initialProgress != null
          ? { progress: outcome.initialProgress }
          : {}),
      });
      return updated ?? undefined;
    } catch (err) {
      if (signal.aborted) {
        await this.markCanceled(task.id);
        return undefined;
      }
      const { kind, message } = errorToKind(err);
      await this.finalizeFailure(task, kind, message);
      return undefined;
    }
  }

  private async runPollPhase(
    task: AsyncTask,
    handler: TaskHandler,
    signal: AbortSignal,
  ): Promise<void> {
    if (!task.externalTaskId) {
      // 异常数据：状态=polling 但没有 external_id（可能是上一版 schema 残留
      // 或 submit 阶段崩溃留下的半状态）。标记失败避免永远停在 polling。
      await this.finalizeFailure(
        task,
        "parse",
        "任务进入轮询阶段但缺少 external_task_id",
      );
      return;
    }
    if (!handler.poll) {
      await this.finalizeFailure(
        task,
        "parse",
        `provider ${task.provider}:${task.kind} 没有 poll handler`,
      );
      return;
    }

    let delay = POLL_INITIAL_DELAY;
    let transientStreak = 0;

    while (!signal.aborted) {
      const current = useTasksStore.getState().getById(task.id);
      if (!current || !ACTIVE_STATUSES.has(current.status)) return;

      const ctx: TaskCtx = {
        task: current,
        signal,
        setProgress: (p) => {
          void this.patch(task.id, { progress: clampProgress(p) });
        },
      };

      try {
        const outcome = await handler.poll(task.externalTaskId, ctx);
        await this.patch(task.id, {
          lastPolledAt: new Date().toISOString(),
        });

        if (outcome.status === "success") {
          await this.finalizeSuccess(current, outcome.result, handler, ctx);
          return;
        }
        if (outcome.status === "failed") {
          await this.finalizeFailure(current, "business_failed", outcome.message);
          return;
        }

        // pending：更新进度，继续轮询
        if (typeof outcome.progress === "number") {
          await this.patch(task.id, { progress: clampProgress(outcome.progress) });
        }
        transientStreak = 0;
        await sleep(delay, signal);
        delay = Math.min(delay * POLL_BACKOFF_FACTOR, POLL_MAX_DELAY);
      } catch (err) {
        if (signal.aborted) {
          await this.markCanceled(task.id);
          return;
        }

        const { kind, message } = errorToKind(err);
        const transient = err instanceof TaskError && err.isTransient;

        if (!transient) {
          await this.finalizeFailure(current, kind, message);
          return;
        }

        // transient：保持 polling 状态，加长退避，继续。
        // 同时把"最近一次错误"写进 errorMessage 但不改 status，UI 可以显示
        // "网络不稳，重试中…"之类的提示。
        transientStreak += 1;
        const recoveryDelay = Math.min(
          TRANSIENT_RECOVERY_BASE * Math.pow(2, transientStreak - 1),
          TRANSIENT_RECOVERY_MAX,
        );
        await this.patch(task.id, {
          errorKind: kind,
          errorMessage: `[transient] ${message}`,
        });
        await sleep(recoveryDelay, signal);
      }
    }

    if (signal.aborted) {
      await this.markCanceled(task.id);
    }
  }

  private async finalizeSuccess(
    task: AsyncTask,
    rawResult: Record<string, unknown>,
    handler: TaskHandler,
    ctx: TaskCtx,
  ): Promise<void> {
    let finalResult = rawResult;
    if (handler.finalize) {
      try {
        finalResult = await handler.finalize(rawResult, ctx);
      } catch (err) {
        // finalize 失败（一般是本地保存失败）：仍认为任务成功，但记一笔错误信息
        console.warn(`[TaskManager] finalize ${task.id} failed:`, err);
      }
    }
    await this.patch(task.id, {
      status: "success",
      progress: 100,
      result: finalResult,
      errorKind: undefined,
      errorMessage: undefined,
    });
  }

  private async finalizeFailure(
    task: AsyncTask,
    kind: TaskErrorKind,
    message: string,
  ): Promise<void> {
    await this.patch(task.id, {
      status: "failed",
      errorKind: kind,
      errorMessage: message,
    });
  }

  private async markCanceled(taskId: string): Promise<void> {
    const current = useTasksStore.getState().getById(taskId);
    if (!current || !ACTIVE_STATUSES.has(current.status)) return;
    await this.patch(taskId, { status: "canceled" });
  }

  /** 局部更新一个字段集 + updatedAt + 落库。 */
  private async patch(
    taskId: string,
    patch: Partial<AsyncTask>,
  ): Promise<AsyncTask | null> {
    const current = useTasksStore.getState().getById(taskId);
    if (!current) return null;
    const next: AsyncTask = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await useTasksStore.getState().upsert(next);
    return next;
  }
}

// ────────────────────────────────────────────────────────────────
// 辅助
// ────────────────────────────────────────────────────────────────

function handlerKey(provider: string, kind: string): string {
  return `${provider}:${kind}`;
}

function clampProgress(p: number): number {
  if (!Number.isFinite(p)) return 0;
  if (p < 0) return 0;
  if (p > 100) return 100;
  return p;
}

function errorToKind(err: unknown): { kind: TaskErrorKind; message: string } {
  if (err instanceof TaskError) {
    return { kind: err.kind, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { kind: "network", message };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const id = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

// ────────────────────────────────────────────────────────────────
// 单例
// ────────────────────────────────────────────────────────────────

export const taskManager = new TaskManager();
