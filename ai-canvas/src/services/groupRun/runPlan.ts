/**
 * 组运行的「规划」层 —— 把一次运行**该跑什么**算清楚,与「怎么跑」(executor)解耦。
 *
 * ─── 两段式,纯核心可单测 ──────────────────────────────────────
 *  • {@link planGroupRun}  —— 不纯边界:从 store 取组成员 / 组内子图 / 失败卡,组装后
 *    调纯核心。诊断日志也在这层(debug-gated)。
 *  • {@link buildRunPlan}  —— 纯函数:环检测 + 部分运行闭包过滤 + 产出运行集的邻接/入度
 *    (供数据流调度器按依赖驱动)。只吃普通数据、不碰 store/React/UI,单测零 mock。
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
 * 组并发上限(安全闸,P3 限流)。**全局**最多同时在途这么多张,其余在数据流调度器的就绪
 * 队列里排队(取代旧「同层」概念 —— 数据流不分层,峰值并发仍由这一个数兜底)。
 *
 * 取 8 的理由:既给常规工作流(几张~十几张)足够并行,又挡住「极端大组几十上百张瞬间发
 * 同等数量 aiProxy IPC + 轮询」打崩 WebView2 的历史风险(本仓 IPC 层对并发无兜底,见
 * lib/ipcLimits.ts),同时压住对上游的瞬时并发降低 429。要更激进/更保守只动这一处,
 * executor / 调度器拿 `plan.concurrency` 不感知;日后可升级为按 provider RPM 取值。
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
  /**
   * 本次实际要跑的全部节点(已按 startNodeIds/onlyFailed 过滤),按 id 字典序排列 ——
   * 既是调度集,也是数据流调度器的**确定性派发序**。
   */
  nodes: string[];
  /** 本次调度的卡总数(= nodes.length)。 */
  total: number;
  /** 同时在途上限。 */
  concurrency: number;
  /**
   * 运行集内的正向邻接表(src→[target...])。调度器据此在节点完成后释放后继;
   * 失败节点不放行后继 → 下游闭包天然不再就绪(失败隔离)。
   */
  adjacency: Map<string, string[]>;
  /**
   * 运行集内各节点入度。调度器据此判定「前驱全部完成 → 该节点就绪可跑」。
   * **限定在运行集内**:部分运行时,运行集外的前驱不会跑,绝不计入入度,否则该节点死等。
   */
  indegree: Map<string, number>;
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
 * 纯核心:给定节点集 + 组内子图边集 + 参数 → 环检测、按起点闭包过滤运行集,产出运行集内的
 * 邻接表 + 入度(数据流调度器据此按依赖驱动)。不读 store、不出 toast、不打日志 —— 完全可单测。
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
  // 环检测:拓扑排序顺带分层,但**分层结果此处仅用于判环** —— 调度已改由数据流按
  // 各节点入度驱动(见 {@link runDataflow}),不再消费这些「层」。
  const sorted = topoSort(cardIds, edges);
  if (isCycle(sorted)) {
    return {
      ok: false,
      reason: "cycle",
      cycleNodes: sorted.cycle,
      detail: `共 ${sorted.cycle.length} 个节点构成环,无法自动调度`,
    };
  }

  const cardSet = new Set(cardIds);

  // 组内子图全量正向邻接表 —— 仅用于部分运行的「起点 + 拓扑后继」闭包 BFS。
  const fullAdjacency = new Map<string, string[]>();
  for (const [s, t] of edges) {
    if (!cardSet.has(s) || !cardSet.has(t)) continue;
    const arr = fullAdjacency.get(s);
    if (arr) arr.push(t);
    else fullAdjacency.set(s, [t]);
  }

  // 解析运行集:部分运行 = startSet ∩ 成员 + 其所有拓扑后继(正向 BFS);否则 = 全体成员。
  let runSet: Set<string>;
  if (params.startSet) {
    runSet = new Set<string>();
    const queue: string[] = [];
    for (const id of params.startSet) {
      if (cardSet.has(id) && !runSet.has(id)) {
        runSet.add(id);
        queue.push(id);
      }
    }
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const nxt of fullAdjacency.get(cur) ?? []) {
        if (!runSet.has(nxt)) {
          runSet.add(nxt);
          queue.push(nxt);
        }
      }
    }
    if (runSet.size === 0) return { ok: false, reason: "empty-range" };
  } else {
    runSet = cardSet;
  }

  // 限定在运行集内重建邻接 + 入度:部分运行时,运行集外的前驱不会跑,绝不能算进入度 ——
  // 否则该节点入度永不归零、永远不就绪(死等一个根本不跑的前驱)。
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of runSet) indegree.set(id, 0);
  for (const [s, t] of edges) {
    if (!runSet.has(s) || !runSet.has(t)) continue;
    const arr = adjacency.get(s);
    if (arr) arr.push(t);
    else adjacency.set(s, [t]);
    indegree.set(t, (indegree.get(t) ?? 0) + 1);
  }

  // 节点按 id 字典序 → 调度器确定性派发序(沿用旧 topoSort 同层 sort 的稳定性习惯)。
  const nodes = [...runSet].sort();

  return {
    ok: true,
    groupId,
    nodes,
    total: nodes.length,
    concurrency: params.concurrency,
    adjacency,
    indegree,
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
