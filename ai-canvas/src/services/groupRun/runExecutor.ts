/**
 * 组运行的「执行」层 —— 拿一份 {@link RunPlan} + 一个 {@link GroupRunControl},逐层调度。
 *
 * ─── 停止的物理落点:两道派发闸门 ──────────────────────────────
 *  排空式停止(control.requestStop)靠这两道闸门实现「在途不动、后续不发」:
 *   • 闸门①(层间):每开新层前 consult `shouldDispatch()`,false → 不再开层。
 *   • 闸门②(层内):每张卡派发前 consult `shouldDispatch()`,false → 返回 `not-dispatched`,
 *     **不调 runCard**(没过提交咽喉、不扣费)。覆盖有界并发时并发池里还没轮到的卡。
 *  已过闸门②、在 `runCard` 内部的卡 = 在途,闸门碰不到它 → 跑到落戳。这正是
 *  「不取消、不暂停在途,但后面不再执行」。
 *
 *  注:`control.signal` 始终透传进 `runCard` —— graceful 下它永不 abort(无害),
 *  仅 forceAbort 时才中断在途。kill 在途是 escalation,不是默认。
 *
 * 本层只负责调度 + 状态机推进 + 诊断日志;toast / 自动清状态归门面(index)。
 */

import { runWithLimit } from "@/lib/concurrency";
import { runCard, type RunCardResult } from "@/services/cardRunner";
import { useCardStore } from "@/stores/cardStore";
import { useGroupRunStatusStore } from "@/stores/groupRunStatusStore";
import { isCardFresh } from "@/services/generation/runFreshness";
import { extractOutput, propagateFromCard } from "@/lib/dataFlow";
import { createLogger } from "@/lib/debug";
import { describeCard, type RunPlan } from "./runPlan";
import type { GroupRunControl } from "./runController";
import {
  isRetryableFailure,
  type ExecutionReport,
  type GroupCardOutcome,
} from "./runOutcome";

const log = createLogger("GroupRun");

interface CardRunReport {
  cid: string;
  outcome: GroupCardOutcome;
  reason?: string;
}

/** 退避 sleep(ms<=0 立即)。 */
const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((res) => setTimeout(res, ms)) : Promise.resolve();

/** 把 cid 的下游闭包(不含自身)加入 blocked —— 失败隔离剪枝(BFS 正向邻接)。 */
function addDownstreamClosure(
  cid: string,
  adjacency: Map<string, string[]>,
  blocked: Set<string>,
): void {
  const queue = [...(adjacency.get(cid) ?? [])];
  while (queue.length > 0) {
    const n = queue.shift()!;
    if (blocked.has(n)) continue;
    blocked.add(n);
    for (const nx of adjacency.get(n) ?? []) queue.push(nx);
  }
}

/**
 * 跑一张卡,对**可重试失败**(限流 / 网络发送失败 = 没扣费)线性退避后重试。
 * 永久错误(可能已计费)/ 已停止 → 不重试,直接返回(计费洁癖,见 isRetryableFailure)。
 */
async function runCardWithRetry(
  cid: string,
  control: GroupRunControl,
  maxRetries: number,
  backoffMs: number,
): Promise<RunCardResult> {
  let attempt = 0;
  for (;;) {
    const r = await runCard(cid, { signal: control.signal });
    if (r.outcome !== "failed" || attempt >= maxRetries) return r;
    if (!isRetryableFailure(r.reason ?? "")) return r;
    if (!control.shouldDispatch()) return r; // 已停止,不再重试
    attempt++;
    log.warn(
      `  ↻ ${describeCard(cid)} 第 ${attempt}/${maxRetries} 次重试(可重试错误): ${r.reason}`,
    );
    await sleep(backoffMs * attempt);
  }
}

export async function executePlan(
  plan: RunPlan,
  control: GroupRunControl,
): Promise<ExecutionReport> {
  useGroupRunStatusStore.getState().start(plan.groupId, plan.total);

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  let firstFailure: { cardId: string; reason: string } | null = null;
  // 失败隔离:被「上游失败」剪枝的卡(连同其下游闭包),后续层一律 not-dispatched。
  const blocked = new Set<string>();

  log.log(
    `execute ${plan.groupId.slice(0, 8)} — ${plan.layers.length} 层 / ${plan.total} 张 / ` +
      `mode=${plan.mode} / 并发=${plan.concurrency === Infinity ? "∞" : plan.concurrency}`,
  );

  for (const [layerIdx, layer] of plan.layers.entries()) {
    // 闸门①:已停止 → 不开新层(剩余层的卡靠末尾守恒式计入 notDispatched)
    if (!control.shouldDispatch()) {
      log.log(`第 ${layerIdx} 层起已停止,后续不派发`);
      break;
    }
    // 失败隔离(P3):不再因失败整停后续层 —— 失败只剪掉「失败卡的下游闭包」(blocked),
    // 与失败无关的独立分支照常跑完。剪枝在层末按 plan.adjacency 计算。

    useGroupRunStatusStore.getState().setCurrent(plan.groupId, layer);
    log.log(`▶ 第 ${layerIdx} 层 (${layer.length} 张):`, layer.map(describeCard));

    const tasks = layer.map((cid) => async (): Promise<CardRunReport> => {
      // 闸门②:停止后本层并发池里还没轮到的卡 → 不发(未过咽喉、不扣费)
      if (!control.shouldDispatch()) return { cid, outcome: "not-dispatched" };
      // 失败隔离:上游失败已把本卡剪枝 → 不发(不扣费);独立分支不受影响。
      if (blocked.has(cid)) return { cid, outcome: "not-dispatched", reason: "上游失败" };
      // resume:新鲜卡(有戳、非在途、输入指纹未变)跳过,不发(不扣费)。
      if (plan.mode === "resume") {
        const card = useCardStore.getState().getCard(cid);
        if (card && isCardFresh(card)) {
          return { cid, outcome: "skipped", reason: "已是最新" };
        }
      }
      const r = await runCardWithRetry(cid, control, plan.maxRetries, plan.retryBackoffMs);
      // 成功后**确定性**把产物注入下游输入,刷新下游 fp(轮到下游那层判定时输入已新 →
      // 自动判为不新鲜并重跑)。不依赖 dataFlow watcher 的异步订阅时序。
      // 仅在产物已就位时传播 —— 否则 extractOutput=none 会**删除**下游 ref(见 dataFlow),
      // 此时让 watcher 在产物落卡时兜底传播。
      if (r.outcome === "ok") {
        const src = useCardStore.getState().getCard(cid);
        if (src && extractOutput(src).kind !== "none") propagateFromCard(cid);
      }
      return { cid, outcome: r.outcome, reason: r.reason };
    });

    const settled = await runWithLimit(tasks, plan.concurrency);

    for (const s of settled) {
      // runCard 内部已 try/catch,正常不会 rejected;仍防御性兜底。
      const rep: CardRunReport =
        s.status === "fulfilled"
          ? s.value
          : {
              cid: "?",
              outcome: "failed",
              reason: String((s.reason as Error)?.message ?? s.reason),
            };

      switch (rep.outcome) {
        case "ok":
          ok++;
          useGroupRunStatusStore.getState().incrementDone(plan.groupId, rep.cid);
          log.log(`  ↳ ${describeCard(rep.cid)} → ok`);
          break;
        case "skipped":
          skipped++;
          // 跳过也算「处理过一个节点」,计入 doneCount,徽章按「已处理」展示
          useGroupRunStatusStore.getState().incrementDone(plan.groupId, rep.cid);
          log.log(`  ↳ ${describeCard(rep.cid)} → 跳过${rep.reason ? ` (${rep.reason})` : ""}`);
          break;
        case "not-dispatched":
          // 不计 doneCount(没处理);末尾守恒式归入 notDispatched
          break;
        case "failed":
          failed++;
          if (!firstFailure)
            firstFailure = { cardId: rep.cid, reason: rep.reason ?? "未知错误" };
          // 失败隔离:剪掉本卡下游闭包(后续层这些卡 not-dispatched);独立分支不动。
          addDownstreamClosure(rep.cid, plan.adjacency, blocked);
          log.warn(`  ↳ ${describeCard(rep.cid)} → 失败: ${rep.reason ?? "未知错误"}`);
          break;
      }
    }
  }

  // 账目守恒:没进 ok/skipped/failed 的(本层闸门②拦下 + 后续层整层未跑)都是「未派发」。
  const notDispatched = Math.max(0, plan.total - ok - skipped - failed);

  // 终结态:用户主动停止 dominates(stopped,不染红);否则有失败 = failed;否则 completed。
  const endState = control.isStopping()
    ? "stopped"
    : firstFailure
      ? "failed"
      : "completed";

  if (endState === "failed" && firstFailure) {
    useGroupRunStatusStore
      .getState()
      .fail(plan.groupId, firstFailure.cardId, firstFailure.reason);
  } else if (endState === "stopped") {
    useGroupRunStatusStore.getState().markStopped(plan.groupId);
  } else {
    useGroupRunStatusStore.getState().complete(plan.groupId);
  }

  log.log(
    `execute 结束: ok=${ok} 跳过=${skipped} 失败=${failed} 未派发=${notDispatched} → ${endState}`,
  );
  return { ok, skipped, failed, notDispatched, endState, firstFailure };
}
