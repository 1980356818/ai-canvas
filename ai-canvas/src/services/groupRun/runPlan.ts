/**
 * 组运行的「规划」层 —— 把一次运行**该跑什么**算清楚,与「怎么跑」(executor)解耦。
 *
 * ─── 两段式,纯核心可单测 ──────────────────────────────────────
 *  • {@link planGroupRun}  —— 不纯边界:从 store 取组成员 / 组内子图 / 失败卡,组装后
 *    调纯核心。诊断日志也在这层(debug-gated)。
 *  • {@link buildRunPlan}  —— 纯函数:拓扑分层 + 环检测 + 部分运行闭包过滤。只吃普通
 *    数据、不碰 store/React/UI,单测零 mock。
 *
 * 产出 {@link RunPlan}(可调度)或 {@link RunPlanRejected}(前置失败,带可读原因 →
 * 门面据此出 toast)。规划层**不出 toast、不动状态机** —— UI 反馈归门面,调度归 executor。
 */

import { topoSort, isCycle } from "@/lib/topoSort";
import { useGroupStore } from "@/stores/groupStore";
import { useCardStore } from "@/stores/cardStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useGroupRunStatusStore } from "@/stores/groupRunStatusStore";
import { reconcileFrameMembership } from "@/lib/frameMembership";
import { createLogger } from "@/lib/debug";

const log = createLogger("GroupRun");

/**
 * 组并发上限(安全闸,P3 限流)。同层最多同时跑这么多张,其余在 runWithLimit 排队。
 *
 * 取 8 的理由:既给常规工作流(几张~十几张)足够并行,又挡住「极端大组同层几十上百张
 * 瞬间发同等数量 aiProxy IPC + 轮询」打崩 WebView2 的历史风险(本仓 IPC 层对并发无兜底,
 * 见 lib/ipcLimits.ts),同时压住对上游的瞬时并发降低 429。要更激进/更保守只动这一处,
 * executor 拿 `plan.concurrency` 不感知;日后可升级为按 provider RPM 取值。
 */
export const DEFAULT_GROUP_CONCURRENCY = 8;

/** 单卡可重试失败(限流/网络发送失败)的最大重试次数。0 = 不重试。 */
export const DEFAULT_MAX_RETRIES = 2;

/** 重试退避基数(ms),线性:第 n 次重试等待 base×n。0 = 立即(测试用)。 */
export const DEFAULT_RETRY_BACKOFF_MS = 1000;

/**
 * 运行模式:
 *  • `resume` —— 断点续跑:跳过「已真生成且输入未变」的新鲜卡,只补没做完的(P2 接入)。
 *  • `rerun`  —— 重新运行:范围内全部重跑,无视新鲜度。
 *
 * P0/P1 阶段 isCardFresh 尚未落地,默认 `rerun`(= 全跑,等价现状);P2 落地新鲜度后
 * 把默认翻成 `resume`(见 services/groupRun task #7)。
 */
export type RunMode = "resume" | "rerun";

export interface RunGroupOptions {
  /**
   * 部分运行的起点节点集。**只跑**这些节点 + 它们在组内子图的所有拓扑后继。
   * 不传/为空 → 跑整个组。
   */
  startNodeIds?: string[];
  /**
   * 只重跑上次失败的节点 + 其后继。与 startNodeIds 互斥(同时给以 startNodeIds 为准)。
   * 取自 GroupRunStatusStore 当前组的 failedCardId(failed 态保留)。
   * P2 起语义并入 resume(失败卡无成功戳,resume 天然重跑),此项保留为别名。
   */
  onlyFailed?: boolean;
  /** 运行模式,默认见 {@link RunMode}。 */
  mode?: RunMode;
}

export interface RunPlan {
  groupId: string;
  /** 实际要调度的拓扑分层(已按 startNodeIds/onlyFailed 过滤)。同层无依赖、可并发。 */
  layers: string[][];
  /** 本次调度的卡总数(= layers 展平长度)。 */
  total: number;
  /** 同层并发上限。 */
  concurrency: number;
  /** 组内子图正向邻接表。executor 的失败隔离剪枝 / 级联传播(P2/P3)复用,免重算。 */
  adjacency: Map<string, string[]>;
  /** 运行模式。 */
  mode: RunMode;
  /** 单卡可重试失败的最大重试次数。 */
  maxRetries: number;
  /** 重试退避基数(ms)。 */
  retryBackoffMs: number;
}

export type RunPlanRejectReason =
  | "group-not-found"
  | "empty"
  | "cycle"
  | "start-not-in-group"
  | "no-failed-node"
  | "empty-range";

/** 前置失败:不进调度。`reason` 决定门面 toast 文案;cycle 带参与环的节点。 */
export interface RunPlanRejected {
  ok: false;
  reason: RunPlanRejectReason;
  detail?: string;
  cycleNodes?: string[];
}

export type RunPlanResult = ({ ok: true } & RunPlan) | RunPlanRejected;

/** 把 cardId 渲染成「短id 类型 "标题"」,让诊断日志一眼看清是哪张卡。 */
export function describeCard(cid: string): string {
  const c = useCardStore.getState().getCard(cid);
  if (!c) return `${cid.slice(0, 8)}(已删除)`;
  return `${cid.slice(0, 8)} ${c.type}${c.title ? ` "${c.title}"` : ""}`;
}

/**
 * 纯核心:给定节点集 + 组内子图边集 + 参数 → 拓扑分层并按起点闭包过滤。
 * 不读 store、不出 toast、不打日志 —— 完全可单测。
 */
export function buildRunPlan(
  groupId: string,
  cardIds: string[],
  edges: [string, string][],
  params: {
    startSet: Set<string> | null;
    mode: RunMode;
    concurrency: number;
    // 重试配置不参与图逻辑(仅透传存进 plan),可选,缺省走 DEFAULT_*。
    maxRetries?: number;
    retryBackoffMs?: number;
  },
): RunPlanResult {
  const sorted = topoSort(cardIds, edges);
  if (isCycle(sorted)) {
    return {
      ok: false,
      reason: "cycle",
      cycleNodes: sorted.cycle,
      detail: `共 ${sorted.cycle.length} 个节点构成环,无法自动调度`,
    };
  }

  // 组内子图正向邻接表 —— 闭包过滤 + executor 复用
  const adjacency = new Map<string, string[]>();
  for (const [s, t] of edges) {
    const arr = adjacency.get(s);
    if (arr) arr.push(t);
    else adjacency.set(s, [t]);
  }

  let layers = sorted.layers;
  if (params.startSet) {
    // 从 startSet 沿正向边 BFS,取「起点 + 所有拓扑后继」,过滤每层(空层剔除,同层序不变)
    const reachable = new Set<string>(params.startSet);
    const queue = [...params.startSet];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const nxt of adjacency.get(cur) ?? []) {
        if (!reachable.has(nxt)) {
          reachable.add(nxt);
          queue.push(nxt);
        }
      }
    }
    layers = sorted.layers
      .map((layer) => layer.filter((cid) => reachable.has(cid)))
      .filter((layer) => layer.length > 0);
    if (layers.length === 0) return { ok: false, reason: "empty-range" };
  }

  const total = layers.reduce((sum, l) => sum + l.length, 0);
  return {
    ok: true,
    groupId,
    layers,
    total,
    concurrency: params.concurrency,
    adjacency,
    mode: params.mode,
    maxRetries: params.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryBackoffMs: params.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS,
  };
}

/**
 * 不纯边界:从 store 收集组成员 / 组内子图 / 失败卡,解析起点集后调 {@link buildRunPlan}。
 */
export function planGroupRun(
  groupId: string,
  opts: RunGroupOptions = {},
): RunPlanResult {
  const groupStore = useGroupStore.getState();
  const group = groupStore.getGroup(groupId);
  if (!group) return { ok: false, reason: "group-not-found" };

  // Frame 容器化:运行前按存储边界重算成员归属,确保「跑的 = 用户在框里看到的卡」。
  // group.cardIds 只是派生缓存,平时由 installFrameMembershipAutoReconcile 订阅卡片几何
  // 自动维护(异步去抖)。组运行须**同步**保证最新,等不了微任务,故这里显式 reconcile
  // 一次再读成员(O(框×卡),仅有变化时落库,代价可忽略)。见 frameMembership 头部契约。
  reconcileFrameMembership(group.projectId);

  const cardStore = useCardStore.getState();
  // reconcile 可能经 updateGroup(不可变写)替换了 group 对象 → 重取最新成员再读 cardIds。
  const cardIds = (groupStore.getGroup(groupId) ?? group).cardIds.filter((cid) =>
    cardStore.getCard(cid),
  );
  if (cardIds.length === 0) return { ok: false, reason: "empty" };

  // 组内子图:两端都在组里的边(组运行 = 严格作用域,不引组外卡)。
  const cardSet = new Set(cardIds);
  const edges: [string, string][] = [];
  const outOfGroupDownstream: [string, string][] = [];
  for (const conn of useConnectionStore.getState().connections.values()) {
    const srcIn = cardSet.has(conn.sourceCardId);
    const dstIn = cardSet.has(conn.targetCardId);
    if (srcIn && dstIn) edges.push([conn.sourceCardId, conn.targetCardId]);
    else if (srcIn && !dstIn)
      outOfGroupDownstream.push([conn.sourceCardId, conn.targetCardId]);
  }

  // 解析部分运行起点集:startNodeIds 优先于 onlyFailed。
  let startSet: Set<string> | null = null;
  if (opts.startNodeIds && opts.startNodeIds.length > 0) {
    startSet = new Set(opts.startNodeIds.filter((cid) => cardSet.has(cid)));
    if (startSet.size === 0) return { ok: false, reason: "start-not-in-group" };
  } else if (opts.onlyFailed) {
    const failedId = useGroupRunStatusStore
      .getState()
      .runningGroups.get(groupId)?.failedCardId;
    if (!failedId || !cardSet.has(failedId))
      return { ok: false, reason: "no-failed-node" };
    startSet = new Set([failedId]);
  }

  // 诊断日志(debug-gated,测试静默):成员 + 组外下游这个最常见的困惑点。
  log.log(
    `plan ${groupId.slice(0, 8)} — 成员 ${cardIds.length} 张`,
    cardIds.map(describeCard),
  );
  if (outOfGroupDownstream.length > 0) {
    log.warn(
      `⚠ ${outOfGroupDownstream.length} 条连线指向组外下游 — 组运行不跑这些卡(只把数据/prompt 注入过去):`,
      outOfGroupDownstream.map(([s, t]) => `${describeCard(s)} → ${describeCard(t)}`),
    );
  }

  return buildRunPlan(groupId, cardIds, edges, {
    startSet,
    // 默认 resume(断点续跑):主运行按钮「永远做对的事」—— 没跑过=全跑,跑过一半/重开=续跑,
    // 全完成=空运行提示。要无视新鲜度全重跑走 rerun(「重新运行整组」按钮)。
    mode: opts.mode ?? "resume",
    concurrency: DEFAULT_GROUP_CONCURRENCY,
    maxRetries: DEFAULT_MAX_RETRIES,
    retryBackoffMs: DEFAULT_RETRY_BACKOFF_MS,
  });
}
