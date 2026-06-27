/**
 * 依赖驱动的并发调度器(dataflow scheduler)—— 通用、与业务无关的 DAG 执行原语。
 *
 * ─── 解决什么 ──────────────────────────────────────────────────
 * 传统「拓扑分层 + 层间屏障」(BSP)调度让一个节点必须等它**所在层之前的所有层**全部
 * 跑完才能开始 —— 哪怕它真正依赖的前驱早就好了。深度不同的独立分支因此被锁步串行
 * (快分支被同层最慢节点拖住)。本调度器改为**数据流**模型:每个节点在**它自己的最后
 * 一个前驱完成的瞬间**入就绪队列,只受自身关键路径约束,与无关分支的进度彻底解耦。
 *
 * ─── 它认识什么 / 不认识什么 ────────────────────────────────────
 * 只认识「节点 id + 正向边 + 入度 + 一个 async runNode 回调」。**不认识**卡片 / store /
 * 计费 / React —— 那些是调用方(executor)的事。故纯算法、零 mock 可单测,且可被任何
 * 需要「按依赖并发跑一张 DAG」的场景复用(组运行 / 未来批处理 / 同步等)。
 *
 * ─── 三道闸(沿用 GroupRunControl 语义)──────────────────────────
 *  • gate()           —— 暂停闸:每次派发前 await。暂停时挂起(并发槽被占,复刻「暂停占咽喉」),
 *                        resume 续跑。
 *  • shouldDispatch() —— 停止闸:每次派发前查,false = 不再起新节点(在途排空)。
 *  • advances(result) —— 由调用方判定本节点是否「放行后继」:成功/跳过→true(后继入度 -1,归零即就绪),
 *                        失败→false(后继入度不减 → 整条下游闭包天然不再就绪 = 失败隔离,
 *                        无需调用方显式做下游剪枝)。
 *
 * ─── 不变量 ────────────────────────────────────────────────────
 *  • 峰值并发 ≤ concurrency(安全闸,保护 IPC / 上游)。
 *  • 拓扑正确:节点只在**它自己**所有前驱 advance 之后才跑。
 *  • 确定性:就绪节点按 `nodes` 给定顺序(调用方传 id 字典序)派发,行为可复现、可测。
 *  • 不挂死:即使有环漏入(调用方应在规划层先拒),环上节点入度永不归零,只会留在
 *    notDispatched,绝不 hang。
 */

export interface DataflowOptions<T> {
  /** 运行集(已过滤)。决定 total 与确定性派发序(建议传 id 字典序)。 */
  nodes: string[];
  /** 正向边邻接表(限定在 `nodes` 内):src → [target...]。 */
  adjacency: Map<string, string[]>;
  /** 各节点入度(限定在 `nodes` 内)。内部复制,**绝不修改入参**。 */
  indegree: Map<string, number>;
  /** 全局并发上限(同一时刻最多在途多少个)。≤0 视为 1;Infinity = 不限。 */
  concurrency: number;
  /** 暂停闸:每次派发前 await。running/stopping 立即放行,paused 挂起直到 resume/stop。 */
  gate: () => Promise<void>;
  /** 停止闸:每次派发前查,false = 不再派发新节点。 */
  shouldDispatch: () => boolean;
  /** 跑一个节点。约定**不抛错**(调用方应内部 try/catch 兜成结果);抛了也会被防御性吞掉。 */
  runNode: (id: string) => Promise<T>;
  /** 本节点是否放行后继(ok/skipped→true,failed→false)。 */
  advances: (result: T) => boolean;
  /** 节点真正起跑(过闸后、调 runNode 前)回调 —— 调用方据此点亮「正在跑」。 */
  onLaunch?: (id: string) => void;
  /** 节点落定(任意结果)回调 —— 调用方据此计数 / 推进状态机 / 记日志。 */
  onSettle?: (id: string, result: T) => void;
}

export interface DataflowResult<T> {
  /** 真正派发并落定的节点 → 结果。 */
  results: Map<string, T>;
  /** 从未派发的节点:被停止闸拦下,或被失败/未完成的前驱卡住(入度未归零)。 */
  notDispatched: string[];
}

/**
 * 按依赖关系并发跑一张 DAG,在停止/暂停闸约束下推进至全部落定或排空停止。
 * resolve 时:在途已全部跑完(排空),不再有新派发。
 */
export async function runDataflow<T>(
  opts: DataflowOptions<T>,
): Promise<DataflowResult<T>> {
  const { nodes, adjacency, gate, shouldDispatch, runNode, advances, onLaunch, onSettle } = opts;
  const limit = Math.max(1, Math.floor(opts.concurrency));

  // 入度复制(绝不改调用方的 plan.indegree)。
  const indegree = new Map<string, number>();
  for (const id of nodes) indegree.set(id, opts.indegree.get(id) ?? 0);

  // 派发优先级 = 节点在 `nodes` 里的下标(调用方传 id 序 → 确定性)。
  const rank = new Map<string, number>();
  nodes.forEach((id, i) => rank.set(id, i));

  const results = new Map<string, T>();

  // 就绪队列:派发时取 rank 最小者(O(n) 扫描,工作流规模小、清晰可读优先)。
  const ready: string[] = [];
  const pushReady = (id: string): void => {
    ready.push(id);
  };
  const popReady = (): string => {
    let best = 0;
    for (let i = 1; i < ready.length; i++) {
      if ((rank.get(ready[i]!) ?? 0) < (rank.get(ready[best]!) ?? 0)) best = i;
    }
    return ready.splice(best, 1)[0]!;
  };

  for (const id of nodes) {
    if ((indegree.get(id) ?? 0) === 0) pushReady(id);
  }

  let inFlight = 0;
  let finished = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => (resolveDone = res));

  const finishIfIdle = (): void => {
    if (finished) return;
    // 没有在途、且(就绪空 或 已停止不再派发)→ 收尾。
    if (inFlight === 0 && (ready.length === 0 || !shouldDispatch())) {
      finished = true;
      resolveDone();
    }
  };

  const releaseSuccessors = (id: string): void => {
    for (const succ of adjacency.get(id) ?? []) {
      const d = (indegree.get(succ) ?? 0) - 1;
      indegree.set(succ, d);
      if (d === 0) pushReady(succ);
    }
  };

  const launchOne = async (id: string): Promise<void> => {
    // inFlight 已在 pump 里同步 ++(保证并发上限);本函数负责在各路径上把它减回去。
    await gate(); // 暂停闸:挂起期间这个槽位被占(复刻「暂停占咽喉、在途不动」)。
    if (!shouldDispatch()) {
      // 停止(含暂停中被停止):不跑、不放行后继、不记 results(自然归入 notDispatched)。
      inFlight--;
      pump();
      return;
    }
    onLaunch?.(id);
    let result: T;
    try {
      result = await runNode(id);
    } catch {
      // 约定 runNode 不抛;防御:抛了当「不放行后继」,无 T 可记 → 归入 notDispatched。
      inFlight--;
      pump();
      return;
    }
    results.set(id, result);
    onSettle?.(id, result);
    inFlight--;
    if (advances(result)) releaseSuccessors(id);
    pump();
  };

  function pump(): void {
    while (shouldDispatch() && inFlight < limit && ready.length > 0) {
      const id = popReady();
      inFlight++;
      void launchOne(id);
    }
    finishIfIdle();
  }

  pump(); // 启动(空图时 finishIfIdle 立即收尾)。
  await done;

  const notDispatched = nodes.filter((id) => !results.has(id));
  return { results, notDispatched };
}
