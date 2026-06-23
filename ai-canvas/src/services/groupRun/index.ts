/**
 * 组运行领域门面 —— 对外**唯一**入口。UI / agent 只依赖这里,内部 plan/executor/
 * controller 的重构不波及调用方。
 *
 * 职责:编排(plan → register → execute → unregister)+ 用户反馈(toast)+ 自动清状态。
 * 「该跑什么」交给 {@link planGroupRun},「怎么跑」交给 {@link executePlan},
 * 「控制意图」交给 {@link GroupRunControl}。三权分立,门面只做粘合。
 *
 * ─── 对外动词 ──────────────────────────────────────────────────
 *  • {@link runGroup}        起跑(resume/rerun/部分运行,见 RunGroupOptions)
 *  • {@link stopGroup}       排空式停止(在途跑完落戳,未派发截断)—— 用户点「停止」的默认
 *  • {@link forceAbortGroup} 强制中止(连在途一起 kill,救场用,极少暴露)
 */

import { useUIStore } from "@/stores/uiStore";
import { useCardStore } from "@/stores/cardStore";
import { useGroupRunStatusStore } from "@/stores/groupRunStatusStore";
import {
  planGroupRun,
  type RunGroupOptions,
  type RunPlanRejected,
} from "./runPlan";
import { executePlan } from "./runExecutor";
import {
  registerRun,
  unregisterRun,
  getRun,
  isRunRegistered,
} from "./runController";
import type { ExecutionReport, RunGroupResult } from "./runOutcome";

export type { RunGroupOptions, RunMode, RunPlan } from "./runPlan";
export type { RunGroupResult, RunGroupEndState } from "./runOutcome";
export { GroupRunControl } from "./runController";

/** 完成/停止/失败态徽章保留显示时长,过后自动清。 */
const STATUS_CLEAR_DELAY_MS = 2500;

/** 前置失败 → toast。group-not-found 静默(用户无感),其余给可读提示。 */
function toastRejection(r: RunPlanRejected): void {
  const ui = useUIStore.getState();
  switch (r.reason) {
    case "group-not-found":
      return;
    case "empty":
      ui.addToast({ type: "info", title: "组里没有可运行的节点", duration: 2000 });
      return;
    case "cycle":
      ui.addToast({
        type: "error",
        title: "组内存在循环依赖",
        description: r.detail,
        duration: 4500,
      });
      return;
    case "start-not-in-group":
      ui.addToast({ type: "warning", title: "起点节点不在此组中", duration: 2500 });
      return;
    case "no-failed-node":
      ui.addToast({ type: "info", title: "没有可重跑的失败节点", duration: 2000 });
      return;
    case "empty-range":
      ui.addToast({ type: "info", title: "没有可运行的节点", duration: 2000 });
      return;
  }
}

/** 终结 → toast。 */
function toastReport(report: ExecutionReport, total: number): void {
  const ui = useUIStore.getState();
  if (report.endState === "failed" && report.firstFailure) {
    const card = useCardStore.getState().getCard(report.firstFailure.cardId);
    const name =
      card?.title || card?.type || report.firstFailure.cardId.slice(0, 6);
    // 失败隔离:可能部分成功 + 部分失败 + 下游剪枝。如实反映,而非笼统「已停止」。
    const partial = report.ok > 0 || report.notDispatched > 0;
    ui.addToast({
      type: "error",
      title: partial
        ? `组运行结束:${report.ok} 成功 / ${report.failed} 失败`
        : "组运行失败",
      description:
        `节点 "${name}" 失败:${report.firstFailure.reason}` +
        (report.notDispatched > 0
          ? `（${report.notDispatched} 个下游已跳过,可「继续」补跑）`
          : ""),
      duration: 5000,
    });
  } else if (report.endState === "stopped") {
    const processed = report.ok + report.skipped;
    ui.addToast({
      type: "info",
      title: `已停止 (完成 ${processed}/${total})`,
      description:
        report.notDispatched > 0
          ? `${report.notDispatched} 个节点未运行,点「继续」补跑`
          : undefined,
      duration: 3000,
    });
  } else if (report.ok === 0 && report.skipped > 0) {
    // resume 下全部新鲜(没真生成任何卡)→ 不报「完成」,提示无需重跑(§6.4)。
    ui.addToast({
      type: "info",
      title: "全部已是最新,无需重跑",
      description: "如需强制重做,用「重新运行整组」",
      duration: 3000,
    });
  } else {
    ui.addToast({
      type: "success",
      title: `组运行完成 (${report.ok}/${total})`,
      description:
        report.skipped > 0 ? `${report.skipped} 个节点已跳过` : undefined,
      duration: 3000,
    });
  }
}

/**
 * 起跑一个组。不存在 / 空 / 成环 / 范围空 → toast 并返回 `ran:false`。
 * 默认不 await 内部各卡(executor 内部已并发),但本函数 await 到整组终结。
 */
export async function runGroup(
  groupId: string,
  opts: RunGroupOptions = {},
): Promise<RunGroupResult> {
  // 重入防御:同组已在跑 → 提示先停止。UI running 态主按钮点的是 stopGroup(不会到这),
  // 此分支主要兜 agent / 自动化重复调用,避免两轮叠跑同一组。
  if (isRunRegistered(groupId)) {
    useUIStore.getState().addToast({
      type: "info",
      title: "该组正在运行中",
      description: "请先停止当前运行",
      duration: 2500,
    });
    return { groupId, ok: 0, skipped: 0, failed: 0, notDispatched: 0, ran: false };
  }

  const plan = planGroupRun(groupId, opts);
  if (!plan.ok) {
    toastRejection(plan);
    return { groupId, ok: 0, skipped: 0, failed: 0, notDispatched: 0, ran: false };
  }

  const control = registerRun(groupId);
  try {
    const report = await executePlan(plan, control);
    toastReport(report, plan.total);
    return {
      groupId,
      ok: report.ok,
      skipped: report.skipped,
      failed: report.failed,
      notDispatched: report.notDispatched,
      ran: true,
      endState: report.endState,
    };
  } finally {
    unregisterRun(groupId, control);
    // 几秒后自动清徽章 —— 但若窗口内又起了新一轮(isRunRegistered),让新一轮自己管,别误清。
    setTimeout(() => {
      if (!isRunRegistered(groupId)) {
        useGroupRunStatusStore.getState().clear(groupId);
      }
    }, STATUS_CLEAR_DELAY_MS);
  }
}

/**
 * 排空式停止:在途卡跑完(已扣费,结果落卡 + 盖戳),未派发的截断不发。
 * 返回 false = 该组当前没在跑(无可停)。
 */
export function stopGroup(groupId: string): boolean {
  const control = getRun(groupId);
  if (!control) return false;
  control.requestStop();
  useGroupRunStatusStore.getState().markStopping(groupId);
  return true;
}

/**
 * 强制中止:在排空式停止基础上 abort 在途的 TaskManager 任务 / chat 出网。
 * 会丢弃已扣费的在途结果,仅用于「任务卡死轮询」等救场。默认不作主操作暴露。
 */
export function forceAbortGroup(groupId: string): boolean {
  const control = getRun(groupId);
  if (!control) return false;
  control.forceAbort();
  useGroupRunStatusStore.getState().markStopping(groupId);
  return true;
}
