/** 任务动词:查状态 / 取消。配合 run.* 返回的 taskId 使用。 */

import type { VerbDefinition } from "../types";
import { fail } from "../types";
import { getJob, snapshot } from "../jobs";
import { cancelGroup } from "@/services/groupRunner";

const taskStatus: VerbDefinition = {
  name: "task.status",
  description:
    "查询 run.card / run.group 返回的 taskId 的状态(running/succeeded/failed/cancelled)与结果。",
  params: {
    type: "object",
    properties: { taskId: { type: "string" } },
    required: ["taskId"],
  },
  async handler(params) {
    const job = getJob(String(params.taskId ?? ""));
    if (!job) throw fail("NOT_FOUND", `任务不存在: ${params.taskId}`);
    return snapshot(job);
  },
};

const taskCancel: VerbDefinition = {
  name: "task.cancel",
  description: "取消一个正在运行的任务(中断在途生成)。",
  params: {
    type: "object",
    properties: { taskId: { type: "string" } },
    required: ["taskId"],
  },
  async handler(params) {
    const job = getJob(String(params.taskId ?? ""));
    if (!job) throw fail("NOT_FOUND", `任务不存在: ${params.taskId}`);
    if (job.state !== "running") {
      return { taskId: job.id, state: job.state };
    }
    // group:走 groupRunner 的取消(停后续层 + 中断在途卡);card:靠 signal 中断。
    // 两者都 abort job.controller。最终状态由 run.* 的后台循环置(见 verbs/run.ts)。
    if (job.kind === "group") cancelGroup(job.targetId);
    job.controller.abort();
    return { taskId: job.id, state: "cancelling" };
  },
};

export const taskVerbs: VerbDefinition[] = [taskStatus, taskCancel];
