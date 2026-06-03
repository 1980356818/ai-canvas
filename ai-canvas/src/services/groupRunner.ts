/**
 * 组运行编排器 —— 一键跑组内所有可运行节点。
 *
 * ─── 算法 ──────────────────────────────────────────────────────
 *  1. 取组的 cardIds 作为节点集;
 *  2. 取**组内子图**(source 和 target 均在 cardIds 内的连线)作为边集;
 *  3. topoSort → 分层结果(同层无依赖,可并发);
 *  4. 逐层用 runWithLimit 调 cardRunner.runCard(cardId)(默认不限制并发,同层全开);
 *  5. 任一卡 failed → 停止后续层 → 写 GroupRunStatus.fail → toast;
 *  6. 全部完成 → 写 GroupRunStatus.complete → 2 秒后清状态。
 *
 * ─── 设计契约 ──────────────────────────────────────────────────
 *  • **组运行 = 严格作用域**:不递归组外上游(组外节点假定已有结果)。这条
 *    契约写在用户文档里,不通过 UI 开关暴露(增配置 = 增鸡肋)。
 *  • 同时只能一个组在跑同一卡(不会出现两个组同时调度同一 cardId,因为
 *    "一卡一组"不变式保证)。两个不同组并行运行是允许的(独立 in-flight)。
 *  • 取消(P3.2):`cancelGroup` abort `controller.signal` → 既停后续层调度,也透传进
 *    `runCard({ signal })`,把在途的 image/video TaskManager 任务经 `taskManager.cancel`
 *    真正停掉、chat 经 `request.signal` 中断出网。不再是"只停层间、在途照跑完"。
 */

import { runWithLimit } from "@/lib/concurrency";
import { topoSort, isCycle } from "@/lib/topoSort";
import { runCard } from "@/services/cardRunner";
import { useGroupStore } from "@/stores/groupStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useCardStore } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { useGroupRunStatusStore } from "@/stores/groupRunStatusStore";
import { createLogger } from "@/lib/debug";

/**
 * 组并发上限。`Infinity` = 不限制:同层有几张卡就同时跑几张(2026-06 按用户要求放开)。
 *
 * ⚠️ 取舍:本仓 IPC 层对"同时多少个 invoke"没有任何兜底 —— ipcLimits 只管单次
 * invoke 的体积、ai.api 里没有并发节流。所以无界并发在**极端大组**(同层几十上百
 * 张卡)下会瞬间发出同等数量的 aiProxy IPC + 轮询循环,有打崩 WebView2 渲染进程的
 * 历史风险(见 lib/ipcLimits.ts 注释的崩溃教训)。常规工作流(几张~十几张)不受影响。
 * 若日后真遇到大组崩溃,把这里改回一个有限值(如 8)即可重新启用节流。
 */
const GROUP_CONCURRENCY = Infinity;

/** 完成态(完成/失败)保留显示时长,过后自动清状态。 */
const STATUS_CLEAR_DELAY_MS = 2500;

const log = createLogger("GroupRun");

/** 把 cardId 渲染成"短id 类型 标题",让组运行诊断日志一眼看清是哪张卡。 */
function describeCard(cid: string): string {
  const c = useCardStore.getState().getCard(cid);
  if (!c) return `${cid.slice(0, 8)}(已删除)`;
  return `${cid.slice(0, 8)} ${c.type}${c.title ? ` "${c.title}"` : ""}`;
}

export interface RunGroupResult {
  groupId: string;
  ok: number;
  skipped: number;
  failed: number;
  /** 因环不执行 / 组不存在等前置失败,返回 false。 */
  ran: boolean;
  /** 用户中途调 cancelGroup 取消 → true。 */
  canceled?: boolean;
}

export interface RunGroupOptions {
  /**
   * F10: 部分运行的起点节点集。**只跑** 这些节点 + 它们在组内子图的所有拓扑后继。
   * 不传/为空 → 跑整个组。
   */
  startNodeIds?: string[];
  /**
   * F10: 只重跑上次失败的节点 + 其后继。
   * 与 startNodeIds 互斥;同时给则以 startNodeIds 为准。
   * 取自 GroupRunStatusStore.runningGroups.get(groupId).failedCardId(failed 态保留)。
   */
  onlyFailed?: boolean;
}

/**
 * F11: 每个组的运行 AbortController 注册表。
 * 重复 runGroup(groupId) 时旧 controller 自动 abort,避免叠跑。
 * cancelGroup(groupId) 外部调用同样的 abort 路径。
 */
const runningControllers = new Map<string, AbortController>();

export function cancelGroup(groupId: string): boolean {
  const ctrl = runningControllers.get(groupId);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}

export async function runGroup(
  groupId: string,
  opts: RunGroupOptions = {},
): Promise<RunGroupResult> {
  const group = useGroupStore.getState().getGroup(groupId);
  if (!group) {
    return { groupId, ok: 0, skipped: 0, failed: 0, ran: false };
  }

  const status = useGroupRunStatusStore.getState();
  const ui = useUIStore.getState();

  // 防御:同一组重复点击 — 不再 toast 拒绝,而是 abort 旧的再开始(用户语义可能是"重跑")
  // cancelGroup 在 GroupShell 失败/运行态点击按钮时也走这个路径。
  const existing = status.runningGroups.get(groupId);
  if (existing && existing.phase === "running") {
    const prev = runningControllers.get(groupId);
    if (prev) prev.abort();
    // 等一个微任务让 abort 路径退出循环
    await new Promise((r) => setTimeout(r, 0));
  }

  // ── 1) 收集组内节点 + 组内子图 ──
  const cardIds = group.cardIds.filter((cid) =>
    useCardStore.getState().getCard(cid),
  );
  if (cardIds.length === 0) {
    ui.addToast({
      type: "info",
      title: "组里没有可运行的节点",
      duration: 2000,
    });
    return { groupId, ok: 0, skipped: 0, failed: 0, ran: false };
  }

  const cardSet = new Set(cardIds);
  const edges: [string, string][] = [];
  const outOfGroupDownstream: string[] = [];
  for (const conn of useConnectionStore.getState().connections.values()) {
    const srcIn = cardSet.has(conn.sourceCardId);
    const dstIn = cardSet.has(conn.targetCardId);
    if (srcIn && dstIn) {
      edges.push([conn.sourceCardId, conn.targetCardId]);
    } else if (srcIn && !dstIn) {
      outOfGroupDownstream.push(
        `${describeCard(conn.sourceCardId)}  →  ${describeCard(conn.targetCardId)}`,
      );
    }
  }

  log.log(
    `runGroup ${groupId.slice(0, 8)} — 成员 ${cardIds.length} 张:`,
    cardIds.map(describeCard),
  );
  log.log(
    `组内子图 ${edges.length} 条边:`,
    edges.map(([s, t]) => `${describeCard(s)}  →  ${describeCard(t)}`),
  );
  if (outOfGroupDownstream.length > 0) {
    // 用户最常见的困惑:卡片连着下游、但下游不在组里。组运行只跑组成员,
    // 不会顺着连线去跑组外的卡(数据流 watcher 仍会把 prompt 注入过去,
    // 所以"看到注入文本、却没生成"正是这种情况)。
    log.warn(
      `⚠ ${outOfGroupDownstream.length} 条连线指向"组外"下游 — 组运行不会跑这些卡(只把数据/prompt 注入过去):`,
      outOfGroupDownstream,
    );
  }

  // ── F10: 解析部分运行的起点集 ──
  // 优先级:explicit startNodeIds > onlyFailed > 全组
  let startSet: Set<string> | null = null;
  if (opts.startNodeIds && opts.startNodeIds.length > 0) {
    startSet = new Set(opts.startNodeIds.filter((cid) => cardSet.has(cid)));
    if (startSet.size === 0) {
      ui.addToast({
        type: "warning",
        title: "起点节点不在此组中",
        duration: 2500,
      });
      return { groupId, ok: 0, skipped: 0, failed: 0, ran: false };
    }
  } else if (opts.onlyFailed) {
    const failedId = existing?.failedCardId;
    if (!failedId || !cardSet.has(failedId)) {
      ui.addToast({
        type: "info",
        title: "没有可重跑的失败节点",
        duration: 2000,
      });
      return { groupId, ok: 0, skipped: 0, failed: 0, ran: false };
    }
    startSet = new Set([failedId]);
  }

  // ── 2) 拓扑排序 ──
  const sorted = topoSort(cardIds, edges);
  if (isCycle(sorted)) {
    log.warn("组内存在环,无法调度:", sorted.cycle.map(describeCard));
    ui.addToast({
      type: "error",
      title: "组内存在循环依赖",
      description: `共 ${sorted.cycle.length} 个节点构成环,无法自动调度`,
      duration: 4500,
    });
    return { groupId, ok: 0, skipped: 0, failed: 0, ran: false };
  }
  log.log(
    `拓扑分层 ${sorted.layers.length} 层:`,
    sorted.layers.map((l, i) => `L${i}: ${l.map(describeCard).join("  |  ")}`),
  );

  // ── F10: 把 layers 过滤为"起点集 + 后继闭包"。
  //
  // 算法:adj 反向用,从 startSet 做 BFS 找所有可达节点(含起点);再用这个集合
  // 过滤每一层。同层节点的相对顺序不变;空层会被跳过。
  let layersToRun = sorted.layers;
  if (startSet) {
    const adj = new Map<string, string[]>();
    for (const [s, t] of edges) {
      let arr = adj.get(s);
      if (!arr) {
        arr = [];
        adj.set(s, arr);
      }
      arr.push(t);
    }
    const reachable = new Set<string>(startSet);
    const queue = [...startSet];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const nxt of adj.get(cur) ?? []) {
        if (!reachable.has(nxt)) {
          reachable.add(nxt);
          queue.push(nxt);
        }
      }
    }
    layersToRun = sorted.layers
      .map((layer) => layer.filter((cid) => reachable.has(cid)))
      .filter((layer) => layer.length > 0);
    if (layersToRun.length === 0) {
      ui.addToast({
        type: "info",
        title: "没有可运行的节点",
        duration: 2000,
      });
      return { groupId, ok: 0, skipped: 0, failed: 0, ran: false };
    }
  }
  const totalToRun = layersToRun.reduce((sum, l) => sum + l.length, 0);
  if (startSet) {
    log.log(
      `部分运行,实跑 ${layersToRun.length} 层:`,
      layersToRun.map((l, i) => `L${i}: ${l.map(describeCard).join("  |  ")}`),
    );
  }
  log.log(
    `本次调度 ${totalToRun} 张卡` +
      (GROUP_CONCURRENCY === Infinity
        ? "(不限制并发,同层全开)"
        : `,并发上限 ${GROUP_CONCURRENCY}`),
  );

  // ── 3) 启动调度 ──
  status.start(groupId, totalToRun);
  const controller = new AbortController();
  runningControllers.set(groupId, controller);

  let okCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let firstFailure: { cardId: string; reason: string } | null = null;
  let canceled = false;

  for (const [layerIdx, layer] of layersToRun.entries()) {
    if (firstFailure) {
      log.warn(
        `因上一层有失败,中止剩余层(从第 ${layerIdx} 层起 ${layer.length} 张未跑):`,
        layer.map(describeCard),
      );
      break; // 上一层有失败,中止后续层
    }
    if (controller.signal.aborted) {
      canceled = true;
      break;
    }

    // 通知 UI 本层在跑的卡片
    useGroupRunStatusStore.getState().setCurrent(groupId, layer);
    log.log(`▶ 第 ${layerIdx} 层开始 (${layer.length} 张):`, layer.map(describeCard));

    // P3.2: 把组的取消信号透传进每张卡 —— cancelGroup abort 后,在途的 image/video
    // TaskManager 任务会被 taskManager.cancel 真正停掉、chat 经 request.signal 中断,
    // 不再是"只停层间调度、在途任务照跑完"。
    const tasks = layer.map((cid) => () => runCard(cid, { signal: controller.signal }));
    const results = await runWithLimit(tasks, GROUP_CONCURRENCY);
    if (controller.signal.aborted) {
      canceled = true;
      break;
    }

    for (let i = 0; i < results.length; i++) {
      const cid = layer[i]!;
      const r = results[i]!;
      if (r.status === "rejected") {
        const reason = String((r.reason as Error)?.message ?? r.reason);
        log.warn(`  ↳ ${describeCard(cid)} → 抛错: ${reason}`);
        failedCount++;
        if (!firstFailure) {
          firstFailure = { cardId: cid, reason };
        }
        continue;
      }
      const outcome = r.value.outcome;
      if (outcome === "ok") {
        log.log(`  ↳ ${describeCard(cid)} → ok`);
        okCount++;
        useGroupRunStatusStore.getState().incrementDone(groupId, cid);
      } else if (outcome === "skipped") {
        log.log(
          `  ↳ ${describeCard(cid)} → 跳过${r.value.reason ? ` (${r.value.reason})` : ""}`,
        );
        skippedCount++;
        // 跳过也算"过了一个节点",计入 doneCount,徽章按"已处理"展示
        useGroupRunStatusStore.getState().incrementDone(groupId, cid);
      } else {
        // failed
        log.warn(`  ↳ ${describeCard(cid)} → 失败: ${r.value.reason ?? "未知错误"}`);
        failedCount++;
        if (!firstFailure) {
          firstFailure = { cardId: cid, reason: r.value.reason ?? "未知错误" };
        }
      }
    }
  }

  // ── 4) 终结状态 + 反馈 ──
  runningControllers.delete(groupId);
  log.log(
    `runGroup 结束: ok=${okCount} 跳过=${skippedCount} 失败=${failedCount}` +
      (canceled ? " (已取消)" : "") +
      (firstFailure
        ? ` — 首个失败 ${describeCard(firstFailure.cardId)}: ${firstFailure.reason}`
        : ""),
  );
  if (firstFailure) {
    useGroupRunStatusStore.getState().fail(
      groupId,
      firstFailure.cardId,
      firstFailure.reason,
    );
    const card = useCardStore.getState().getCard(firstFailure.cardId);
    const title = card?.title || card?.type || firstFailure.cardId.slice(0, 6);
    ui.addToast({
      type: "error",
      title: `组运行已停止`,
      description: `节点 "${title}" 失败:${firstFailure.reason}`,
      duration: 5000,
    });
  } else if (canceled) {
    // F11: 用户主动取消 → fail 态(描述清晰),保留已完成进度
    useGroupRunStatusStore.getState().fail(groupId, "", "用户已停止运行");
    ui.addToast({
      type: "info",
      title: `组运行已停止 (${okCount}/${totalToRun})`,
      duration: 2500,
    });
  } else {
    useGroupRunStatusStore.getState().complete(groupId);
    ui.addToast({
      type: "success",
      title: `组运行完成 (${okCount}/${totalToRun})`,
      description:
        skippedCount > 0 ? `${skippedCount} 个节点已跳过` : undefined,
      duration: 3000,
    });
  }

  // 几秒后自动清状态,避免徽章一直留在那
  setTimeout(() => {
    useGroupRunStatusStore.getState().clear(groupId);
  }, STATUS_CLEAR_DELAY_MS);

  return {
    groupId,
    ok: okCount,
    skipped: skippedCount,
    failed: failedCount,
    ran: true,
    canceled,
  };
}
