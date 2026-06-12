/**
 * 把自动化动词层适配成应用内对话面板(AgentPanel)的工具。
 *
 * 对话面板与外部 AI 工具(Claude Code / Codex)**共用同一套动词** —— 门禁/黑箱/持久化
 * 一处实现,行为一致。差异仅两点(对话端专属增强):
 *   1. **run.* 同步化**:对话里用户在等结果,适配器轮询 job 到终态再返回(底层仍复用
 *      verbs 的异步 job,不另写一套生成逻辑)。
 *   2. **镜头跟随**:建卡 / 出图成功后把画布居中到该卡,用户眼看着 AI 干活。
 *
 * 生成类能力(文生图 / 写文案 / 识图)仍由 generate_* 工具承担;本桥负责画布**编排**
 * (建卡 / 连线 / 运行 / 快照 / 项目)。
 */

import type { ToolDefinition } from "../types";
import { verbRegistry } from "@/services/automation/registry";
import { registerAllVerbs } from "@/services/automation/verbs";
import { VerbError } from "@/services/automation/types";
import { getJob, snapshot, type JobSnapshot } from "@/services/automation/jobs";
import { useCardStore } from "@/stores/cardStore";
import { useCanvasStore } from "@/stores/canvasStore";

/** 对话面板暴露给 LLM 的动词(编排类)。describe/logs/list/task.* 不暴露:同步语义下用不到。 */
const PANEL_VERBS = [
  "canvas.snapshot",
  "card.create",
  "card.update",
  "card.delete",
  "connection.create",
  "connection.delete",
  "run.card",
  "run.group",
  "project.create",
  "project.open",
  "spec.import",
] as const;

const SYNC_RUN_VERBS = new Set<string>(["run.card", "run.group"]);

/** LLM 工具名不能含点(部分 provider 限制 `^[a-zA-Z0-9_-]+$`),用下划线替代。 */
function toToolName(verb: string): string {
  return verb.replace(/\./g, "_");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询 job 到终态,把异步 run 变成对话端的同步等待。带 10 分钟兜底超时。 */
async function pollJobToEnd(taskId: string): Promise<JobSnapshot> {
  const deadline = Date.now() + 600_000;
  for (;;) {
    const job = getJob(taskId);
    if (!job) {
      return {
        taskId,
        kind: "card",
        targetId: "",
        state: "failed",
        startedAt: Date.now(),
        error: "任务句柄丢失",
      };
    }
    if (job.state !== "running" || Date.now() > deadline) {
      return snapshot(job);
    }
    await sleep(500);
  }
}

/** 把画布居中到某卡片(镜头跟随)。viewport 坐标语义见 context.ts findOpenPosition。 */
function centerOnCard(cardId: string): void {
  const card = useCardStore.getState().getCard(cardId);
  if (!card) return;
  const vp = useCanvasStore.getState().viewport;
  const cx = card.x + card.width / 2;
  const cy = card.y + card.height / 2;
  useCanvasStore.getState().setViewport({
    x: vp.width / 2 - cx * vp.zoom,
    y: vp.height / 2 - cy * vp.zoom,
  });
}

let panelReqSeq = 0;

function verbToTool(verbName: string): ToolDefinition {
  const verb = verbRegistry.get(verbName);
  if (!verb) {
    throw new Error(`[automation-bridge] 动词未注册: ${verbName}`);
  }
  return {
    name: toToolName(verbName),
    description: verb.description,
    parameters: verb.params,
    async execute(args, ctx) {
      // 默认在当前对话所属项目里操作;LLM 显式传 projectId 则覆盖(如 project.open / 跨项目)。
      const params = { projectId: ctx.projectId, ...args };
      panelReqSeq += 1;
      const vctx = { source: "panel" as const, requestId: `panel_${panelReqSeq}` };
      try {
        if (SYNC_RUN_VERBS.has(verbName)) {
          const out = (await verb.handler(params, vctx)) as { taskId: string };
          const result = await pollJobToEnd(out.taskId);
          if (result.state === "succeeded" && result.kind === "card" && result.targetId) {
            centerOnCard(result.targetId);
          }
          return { success: result.state === "succeeded", data: result };
        }

        const data = await verb.handler(params, vctx);
        if (
          verbName === "card.create" &&
          data &&
          typeof data === "object" &&
          "cardId" in data
        ) {
          centerOnCard((data as { cardId: string }).cardId);
        }
        return { success: true, data };
      } catch (err) {
        if (err instanceof VerbError) {
          return { success: false, data: { error: err.message, code: err.code } };
        }
        return {
          success: false,
          data: { error: err instanceof Error ? err.message : String(err) },
        };
      }
    },
  };
}

/**
 * 构建对话面板的画布编排工具集。
 *
 * 先 `registerAllVerbs()`(幂等)确保动词已注册 —— 本函数在 agentStore 模块加载时被调,
 * 早于自动化 host 的 install,不能依赖 host 的注册时序。
 */
export function buildAutomationTools(): ToolDefinition[] {
  registerAllVerbs();
  return PANEL_VERBS.map(verbToTool);
}
