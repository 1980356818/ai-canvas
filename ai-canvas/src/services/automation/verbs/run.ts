/**
 * 运行动词:跑单卡 / 跑分组。立即返回 taskId(异步 job),用 task.status 轮询。
 *
 * ⚠️ 运行会真实触发生成 → 真实扣费。动词描述里明确告知调用方。
 */

import type { VerbDefinition } from "../types";
import { fail } from "../types";
import { runCard } from "@/services/cardRunner";
import { runGroup } from "@/services/groupRun";
import { useCardStore } from "@/stores/cardStore";
import { useGroupStore } from "@/stores/groupStore";
import {
  createJob,
  settleSucceeded,
  settleFailed,
  settleCancelled,
} from "../jobs";

/** 从卡片 data 提取产物引用(供 job 结果摘要)。 */
function collectCardResult(cardId: string): Record<string, unknown> {
  const data = (useCardStore.getState().getCard(cardId)?.data ?? {}) as Record<
    string,
    unknown
  >;
  const out: Record<string, unknown> = {};
  if (typeof data.imageUrl === "string") out.imageUrl = data.imageUrl;
  if (typeof data.videoUrl === "string") out.videoUrl = data.videoUrl;
  if (typeof data.result === "string") out.text = data.result;
  if (Array.isArray(data.results)) out.resultCount = data.results.length;
  return out;
}

const runCardVerb: VerbDefinition = {
  name: "run.card",
  description:
    "运行一张卡片(生成图片/视频/对话等)。立即返回 taskId;用 task.status 轮询直到 succeeded/failed。注意:运行会真实消耗额度。",
  params: {
    type: "object",
    properties: { cardId: { type: "string" } },
    required: ["cardId"],
  },
  async handler(params) {
    const cardId = String(params.cardId ?? "");
    if (!useCardStore.getState().getCard(cardId)) {
      throw fail("NOT_FOUND", `卡片不存在: ${cardId}`);
    }
    const job = createJob("card", cardId);
    void (async () => {
      try {
        const result = await runCard(cardId, { signal: job.controller.signal });
        if (job.controller.signal.aborted) {
          settleCancelled(job);
        } else if (result.outcome === "ok") {
          settleSucceeded(job, { outcome: "ok", ...collectCardResult(cardId) });
        } else if (result.outcome === "skipped") {
          settleSucceeded(job, { outcome: "skipped", reason: result.reason });
        } else {
          settleFailed(job, result.reason ?? "运行失败");
        }
      } catch (err) {
        settleFailed(job, err instanceof Error ? err.message : String(err));
      }
    })();
    return { taskId: job.id, state: "running" };
  },
};

const runGroupVerb: VerbDefinition = {
  name: "run.group",
  description:
    "按拓扑顺序运行一个分组内的所有卡片(自动处理上下游依赖)。立即返回 taskId。注意:运行会真实消耗额度。",
  params: {
    type: "object",
    properties: { groupId: { type: "string" } },
    required: ["groupId"],
  },
  async handler(params) {
    const groupId = String(params.groupId ?? "");
    if (!useGroupStore.getState().getGroup(groupId)) {
      throw fail("NOT_FOUND", `分组不存在: ${groupId}`);
    }
    const job = createJob("group", groupId);
    void (async () => {
      try {
        // agent 默认显式 rerun 以保确定性(不依赖全局默认 mode)。
        const result = await runGroup(groupId, { mode: "rerun" });
        if (result.endState === "stopped") {
          settleCancelled(job);
        } else if (result.failed > 0) {
          settleFailed(job, `${result.failed} 个节点失败`);
        } else {
          settleSucceeded(job, { ok: result.ok, skipped: result.skipped });
        }
      } catch (err) {
        settleFailed(job, err instanceof Error ? err.message : String(err));
      }
    })();
    return { taskId: job.id, state: "running" };
  },
};

export const runVerbs: VerbDefinition[] = [runCardVerb, runGroupVerb];
