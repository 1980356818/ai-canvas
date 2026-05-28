/**
 * 组运行编排器 —— 一键跑组内所有可运行节点。
 *
 * ─── 算法 ──────────────────────────────────────────────────────
 *  1. 取组的 cardIds 作为节点集;
 *  2. 取**组内子图**(source 和 target 均在 cardIds 内的连线)作为边集;
 *  3. topoSort → 分层结果(同层无依赖,可并发);
 *  4. 逐层用 runWithLimit(并发上限 3)调 cardRunner.runCard(cardId);
 *  5. 任一卡 failed → 停止后续层 → 写 GroupRunStatus.fail → toast;
 *  6. 全部完成 → 写 GroupRunStatus.complete → 2 秒后清状态。
 *
 * ─── 设计契约 ──────────────────────────────────────────────────
 *  • **组运行 = 严格作用域**:不递归组外上游(组外节点假定已有结果)。这条
 *    契约写在用户文档里,不通过 UI 开关暴露(增配置 = 增鸡肋)。
 *  • 同时只能一个组在跑同一卡(不会出现两个组同时调度同一 cardId,因为
 *    "一卡一组"不变式保证)。两个不同组并行运行是允许的(独立 in-flight)。
 *  • 不取消:第一版没有 stop 按钮。tasksStore.cancel 接口在 M3+ 调研后再加。
 */

import { runWithLimit } from "@/lib/concurrency";
import { topoSort, isCycle } from "@/lib/topoSort";
import { runCard } from "@/services/cardRunner";
import { useGroupStore } from "@/stores/groupStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useCardStore } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { useGroupRunStatusStore } from "@/stores/groupRunStatusStore";

/** 组并发上限。同层节点最多同时跑 N 个;过高会撑爆 GPU/IPC,过低浪费资源。 */
const GROUP_CONCURRENCY = 3;

/** 完成态(完成/失败)保留显示时长,过后自动清状态。 */
const STATUS_CLEAR_DELAY_MS = 2500;

export interface RunGroupResult {
  groupId: string;
  ok: number;
  skipped: number;
  failed: number;
  /** 因环不执行 / 组不存在等前置失败,返回 false。 */
  ran: boolean;
}

export async function runGroup(groupId: string): Promise<RunGroupResult> {
  const group = useGroupStore.getState().getGroup(groupId);
  if (!group) {
    return { groupId, ok: 0, skipped: 0, failed: 0, ran: false };
  }

  const status = useGroupRunStatusStore.getState();
  const ui = useUIStore.getState();

  // 防御:同一组重复点击
  const existing = status.runningGroups.get(groupId);
  if (existing && existing.phase === "running") {
    ui.addToast({
      type: "info",
      title: "该组正在运行中",
      duration: 2000,
    });
    return { groupId, ok: 0, skipped: 0, failed: 0, ran: false };
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
  for (const conn of useConnectionStore.getState().connections.values()) {
    if (cardSet.has(conn.sourceCardId) && cardSet.has(conn.targetCardId)) {
      edges.push([conn.sourceCardId, conn.targetCardId]);
    }
  }

  // ── 2) 拓扑排序 ──
  const sorted = topoSort(cardIds, edges);
  if (isCycle(sorted)) {
    ui.addToast({
      type: "error",
      title: "组内存在循环依赖",
      description: `共 ${sorted.cycle.length} 个节点构成环,无法自动调度`,
      duration: 4500,
    });
    return { groupId, ok: 0, skipped: 0, failed: 0, ran: false };
  }

  // ── 3) 启动调度 ──
  status.start(groupId, cardIds.length);

  let okCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let firstFailure: { cardId: string; reason: string } | null = null;

  for (const layer of sorted.layers) {
    if (firstFailure) break; // 上一层有失败,中止后续层

    // 通知 UI 本层在跑的卡片
    useGroupRunStatusStore.getState().setCurrent(groupId, layer);

    const tasks = layer.map((cid) => () => runCard(cid));
    const results = await runWithLimit(tasks, GROUP_CONCURRENCY);

    for (let i = 0; i < results.length; i++) {
      const cid = layer[i]!;
      const r = results[i]!;
      if (r.status === "rejected") {
        failedCount++;
        if (!firstFailure) {
          firstFailure = {
            cardId: cid,
            reason: String((r.reason as Error)?.message ?? r.reason),
          };
        }
        continue;
      }
      const outcome = r.value.outcome;
      if (outcome === "ok") {
        okCount++;
        useGroupRunStatusStore.getState().incrementDone(groupId);
      } else if (outcome === "skipped") {
        skippedCount++;
        // 跳过也算"过了一个节点",计入 doneCount,徽章按"已处理"展示
        useGroupRunStatusStore.getState().incrementDone(groupId);
      } else {
        // failed
        failedCount++;
        if (!firstFailure) {
          firstFailure = { cardId: cid, reason: r.value.reason ?? "未知错误" };
        }
      }
    }
  }

  // ── 4) 终结状态 + 反馈 ──
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
  } else {
    useGroupRunStatusStore.getState().complete(groupId);
    ui.addToast({
      type: "success",
      title: `组运行完成 (${okCount}/${cardIds.length})`,
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
  };
}
