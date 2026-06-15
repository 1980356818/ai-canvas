/**
 * 自动化运行任务注册表 (`run.*` 动词的异步句柄)。
 *
 * 为什么需要它:`cardRunner.runCard` / `groupRun.runGroup` 是 await 到完成的 (生成
 * 30–200s)。若 `run.card` 同步等完再回 HTTP,agent 端会长时间挂起。改成:`run.*` 立即
 * 建一个 job 并后台跑,返回 `jobId`;agent 轮询 `task.status`,完成后 `task.cancel` 可中断。
 *
 * 这是 automation 层自己的 job (区别于 cardRunner 内部的 TaskManager 任务)—— 它包住整个
 * runCard/runGroup 的 Promise,只对外暴露 state/result,不关心底层是图/视频/chat。
 */

export type JobState = "running" | "succeeded" | "failed" | "cancelled";

export interface Job {
  id: string;
  kind: "card" | "group";
  targetId: string;
  state: JobState;
  startedAt: number;
  finishedAt?: number;
  /** 成功时的结果摘要 (各 run 动词自定义,通常含产物引用)。 */
  result?: unknown;
  /** 失败原因 (state==="failed")。 */
  error?: string;
  /** 取消句柄:透传给 runCard(signal);分组停止走 stopGroup(不经此 controller)。 */
  controller: AbortController;
}

/** 对外快照 (不含 controller)。`task.status` 返回它。 */
export interface JobSnapshot {
  taskId: string;
  kind: "card" | "group";
  targetId: string;
  state: JobState;
  startedAt: number;
  finishedAt?: number;
  result?: unknown;
  error?: string;
}

const jobs = new Map<string, Job>();
let seq = 0;

function newJobId(): string {
  seq += 1;
  return `t_${seq}_${Math.floor(performance.now())}`;
}

export function createJob(kind: "card" | "group", targetId: string): Job {
  const job: Job = {
    id: newJobId(),
    kind,
    targetId,
    state: "running",
    startedAt: Date.now(),
    controller: new AbortController(),
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function snapshot(job: Job): JobSnapshot {
  return {
    taskId: job.id,
    kind: job.kind,
    targetId: job.targetId,
    state: job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result: job.result,
    error: job.error,
  };
}

export function settleSucceeded(job: Job, result: unknown): void {
  if (job.state !== "running") return;
  job.state = "succeeded";
  job.result = result;
  job.finishedAt = Date.now();
}

export function settleFailed(job: Job, error: string): void {
  if (job.state !== "running") return;
  job.state = "failed";
  job.error = error;
  job.finishedAt = Date.now();
}

export function settleCancelled(job: Job): void {
  if (job.state !== "running") return;
  job.state = "cancelled";
  job.finishedAt = Date.now();
}
