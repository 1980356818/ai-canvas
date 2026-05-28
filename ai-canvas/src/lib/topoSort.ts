/**
 * 拓扑排序(Kahn 算法,分层版本)。
 *
 * 给定节点集 + 有向边集,返回:
 *   • `layers` —— 二维数组,layers[k] = 第 k 层的节点 id 集合。**同层节点之间无依赖**,
 *     可放心并发执行;
 *   • 或 `cycle` —— 检测到环时返回参与环的节点 id(只挑一份代表性的样本,够用户
 *     定位即可),不返回 layers。
 *
 * ─── 为什么是"分层"而不是"线性序" ──────────────────────────────
 * groupRunner 需要并发跑独立节点,线性序会让本可同时跑的两张图片节点退化成串行;
 * 分层后第 k 层用 runWithLimit 并发,k+1 层等 k 完才开始,这是最自然的并行调度。
 *
 * ─── 复杂度 ────────────────────────────────────────────────────
 *   O(V + E),节点和边各遍历常数次。
 */

export interface TopoLayerResult {
  layers: string[][];
}

export interface TopoCycleResult {
  cycle: string[];
}

export type TopoResult = TopoLayerResult | TopoCycleResult;

export function isCycle(r: TopoResult): r is TopoCycleResult {
  return "cycle" in r;
}

/**
 * @param nodes 参与拓扑排序的节点 id(去重)。
 * @param edges 有向边,[source, target]。**只考虑** 两端都在 nodes 里的边
 *              (调用方负责过滤,避免组运行越界引入组外卡片)。
 */
export function topoSort(
  nodes: Iterable<string>,
  edges: Iterable<readonly [string, string]>,
): TopoResult {
  const nodeSet = new Set(nodes);
  if (nodeSet.size === 0) return { layers: [] };

  // 入度 + 邻接表(只保留两端均在 nodeSet 的边)
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of nodeSet) {
    indegree.set(id, 0);
    adj.set(id, []);
  }
  for (const [src, dst] of edges) {
    if (!nodeSet.has(src) || !nodeSet.has(dst)) continue;
    if (src === dst) continue; // 自环忽略(不会改变拓扑顺序,但会构成"环")
    adj.get(src)!.push(dst);
    indegree.set(dst, indegree.get(dst)! + 1);
  }

  const layers: string[][] = [];
  let current: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) current.push(id);
  }

  let consumed = 0;
  while (current.length > 0) {
    // 按 id 字典序排,保证同输入下输出稳定(便于测试和用户体验一致性)
    current.sort();
    layers.push(current);
    consumed += current.length;
    const next: string[] = [];
    for (const id of current) {
      for (const dst of adj.get(id)!) {
        const d = indegree.get(dst)! - 1;
        indegree.set(dst, d);
        if (d === 0) next.push(dst);
      }
    }
    current = next;
  }

  if (consumed < nodeSet.size) {
    // 仍有入度 > 0 的节点 → 存在环。把这些节点全部返回作为定位线索。
    const cycle: string[] = [];
    for (const [id, deg] of indegree) {
      if (deg > 0) cycle.push(id);
    }
    cycle.sort();
    return { cycle };
  }

  return { layers };
}
