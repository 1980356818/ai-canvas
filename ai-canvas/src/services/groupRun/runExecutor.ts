/**
 * 组运行的「执行」层 —— 拿一份 {@link RunPlan} + 一个 {@link GroupRunControl},按**数据流**调度。
 *
 * ─── 数据流调度(取代旧的「拓扑分层 + 层间屏障」)──────────────────
 *  调度机制下沉到通用原语 {@link runDataflow}:每个节点在**它自己的最后一个前驱完成的瞬间**
 *  就绪可跑,只受自身关键路径约束,与无关分支的进度解耦。根治旧版「层屏障」把深度不同的独立
 *  分支锁步串行(快分支被同层最慢节点拖住)的问题。本层只提供「单卡怎么跑 + 怎么记账」,把
 *  「何时跑、并发多少、停止闸」交给调度器。
 *
 * ─── 停止的物理落点:调度器的派发闸 ────────────────────────────────
 *  排空式停止(control.requestStop)靠调度器在每次派发前 consult `shouldDispatch()` 实现
 *  「在途不动、后续不发」:已过咽喉、在途的卡跑到落戳(钱已花,结果要留);未派发的(被停止闸
 *  拦下的就绪卡)不发(不扣费)。`control.signal` 始终透传进 `runCard` —— graceful 下永不
 *  abort(无害),仅 forceAbort 时才中断在途。本控制器无「暂停」语义,故调度器的暂停闸传но-op。
 *
 * ─── 失败隔离(本仓默认且唯一策略)────────────────────────────────
 *  任一节点 failed → **不放行后继**(advances=false)→ 其下游闭包在数据流里天然不再就绪
 *  = 失败隔离,与失败无关的独立分支照跑。**无需**旧版的显式下游剪枝(addDownstreamClosure)。
 *  不整停后续(无 fail-fast):用户没主动停就把能跑的都跑完,终态按是否有失败收尾。
 *
 * 本层只负责单卡生命周期 + 计数 + 状态机推进 + 诊断日志;toast / 自动清状态归门面(index)。
 */

import { runDataflow } from "@/lib/dataflowScheduler";
import { runCard, type RunCardResult, type RunCardOutcome } from "@/services/cardRunner";
import { useCardStore } from "@/stores/cardStore";
import { useGroupRunStatusStore } from "@/stores/groupRunStatusStore";
import { isCardFresh } from "@/services/generation/runFreshness";
import { extractOutput, propagateFromCard } from "@/lib/dataFlow";
import { createLogger } from "@/lib/debug";
import { describeCard, type RunPlan } from "./runPlan";
import type { GroupRunControl } from "./runController";
import { isRetryableFailure, type ExecutionReport } from "./runOutcome";

const log = createLogger("GroupRun");

/** 单卡跑完的组级处置报告(not-dispatched 是调度器层概念,不在此产生)。 */
interface CardRunReport {
  outcome: RunCardOutcome;
  reason?: string;
}

/** 退避 sleep(ms<=0 立即)。 */
const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((res) => setTimeout(res, ms)) : Promise.resolve();

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
  const status = useGroupRunStatusStore.getState();
  status.start(plan.groupId, plan.total);

  log.log(
    `execute ${plan.groupId.slice(0, 8)} — ${plan.total} 节点 / ` +
      `mode=${plan.mode} / 并发=${plan.concurrency === Infinity ? "∞" : plan.concurrency} / 数据流调度`,
  );

  /**
   * 单卡生命周期(派发/停止闸已由调度器在调用前过完):
   *   resume 新鲜度跳过 → 重试跑 → 成功传播下游。
   * 约定**返回结果、不抛错**(异常在此兜成 failed,而非泄漏给调度器静默丢)。
   */
  const runNode = async (cid: string): Promise<CardRunReport> => {
    try {
      // resume:新鲜卡(有戳、非在途、输入指纹未变)跳过,不发(不扣费),但仍放行下游
      // (下游那层判定时输入已新 → 自动判为不新鲜并重跑)。
      if (plan.mode === "resume") {
        const card = useCardStore.getState().getCard(cid);
        if (card && isCardFresh(card)) return { outcome: "skipped", reason: "已是最新" };
      }

      const r = await runCardWithRetry(cid, control, plan.maxRetries, plan.retryBackoffMs);

      // 成功后确定性把产物注入下游输入,刷新下游 fp。仅产物已就位时传播 —— 否则 extractOutput=none
      // 会**删除**下游 ref(见 dataFlow),此时让 watcher 在产物落卡时兜底传播。
      if (r.outcome === "ok") {
        const src = useCardStore.getState().getCard(cid);
        if (src && extractOutput(src).kind !== "none") propagateFromCard(cid);
      }
      return { outcome: r.outcome, reason: r.reason };
    } catch (err) {
      // runCard 内部已 try/catch,正常不会到这;防御兜底:把异常计为失败(而非静默丢成 not-dispatched)。
      const reason = err instanceof Error ? err.message : String(err);
      return { outcome: "failed", reason };
    }
  };

  const { results } = await runDataflow<CardRunReport>({
    nodes: plan.nodes,
    adjacency: plan.adjacency,
    indegree: plan.indegree,
    concurrency: plan.concurrency,
    // 本控制器无暂停语义 → 暂停闸 no-op;停止闸沿用 shouldDispatch。
    gate: () => Promise.resolve(),
    shouldDispatch: () => control.shouldDispatch(),
    runNode,
    // ok/skipped 放行后继;failed 扣住(下游闭包不再就绪 = 失败隔离)。
    advances: (r) => r.outcome !== "failed",
    // 真正起跑:点亮「正在跑」(补 generatingCards 前后空档,编辑器据此禁「生成」)。
    onLaunch: (cid) => status.addCurrent(plan.groupId, cid),
    // 落定:**实时**进度 + 诊断日志。终态账目(计数 / 首个失败)在下方从 results 统一汇总,
    // 不在闭包里累加 —— 闭包内的 mutation 出不了 TS CFA,放 top-level 既正确又类型友好。
    onSettle: (cid, r) => {
      switch (r.outcome) {
        case "ok":
          status.incrementDone(plan.groupId, cid);
          log.log(`  ↳ ${describeCard(cid)} → ok`);
          break;
        case "skipped":
          // 跳过也算「处理过一个节点」,计入 doneCount,徽章按「已处理」展示。
          status.incrementDone(plan.groupId, cid);
          log.log(`  ↳ ${describeCard(cid)} → 跳过${r.reason ? ` (${r.reason})` : ""}`);
          break;
        case "failed":
          // 失败卡即时退出「正在跑」高亮(不计 done);失败锚点由终态 fail() 统一标红。
          status.removeCurrent(plan.groupId, cid);
          log.warn(`  ↳ ${describeCard(cid)} → 失败: ${r.reason ?? "未知错误"}`);
          break;
      }
    },
  });

  // 终态账目:从结果集统一汇总 ok/skipped/failed + 首个失败锚点(results 按完成顺序)。
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  let firstFailure: { cardId: string; reason: string } | null = null;
  for (const [cid, r] of results) {
    if (r.outcome === "ok") ok++;
    else if (r.outcome === "skipped") skipped++;
    else {
      failed++;
      if (!firstFailure) firstFailure = { cardId: cid, reason: r.reason ?? "未知错误" };
    }
  }
  // 账目守恒:没进 ok/skipped/failed 的(被停止闸拦下 + 被失败/未完成前驱卡住)都是「未派发」。
  const notDispatched = Math.max(0, plan.total - ok - skipped - failed);

  // 终结态:用户主动停止 dominates(stopped,不染红);否则有失败 = failed;否则 completed。
  const endState = control.isStopping()
    ? "stopped"
    : firstFailure
      ? "failed"
      : "completed";

  if (endState === "failed" && firstFailure) {
    status.fail(plan.groupId, firstFailure.cardId, firstFailure.reason);
  } else if (endState === "stopped") {
    status.markStopped(plan.groupId);
  } else {
    status.complete(plan.groupId);
  }

  log.log(
    `execute 结束: ok=${ok} 跳过=${skipped} 失败=${failed} 未派发=${notDispatched} → ${endState}`,
  );
  return { ok, skipped, failed, notDispatched, endState, firstFailure };
}
