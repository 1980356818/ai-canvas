import { describe, it, expect } from "vitest";
import { runDataflow } from "../dataflowScheduler";

// ── 测试辅助 ────────────────────────────────────────────────────────────────

/** 手动控制何时兑现的 promise。 */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

/** 把当前所有微任务链排空(让纯同步的 runNode 链一路推进到底)。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** 从 nodes + edges 建 adjacency + indegree(限定在 nodes 内)。 */
function graph(nodes: string[], edges: [string, string][]) {
  const set = new Set(nodes);
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of nodes) indegree.set(id, 0);
  for (const [s, t] of edges) {
    if (!set.has(s) || !set.has(t)) continue;
    (adjacency.get(s) ?? adjacency.set(s, []).get(s)!).push(t);
    indegree.set(t, (indegree.get(t) ?? 0) + 1);
  }
  return { adjacency, indegree };
}

/** 默认闸:不暂停、不停止。 */
const openGates = {
  gate: async () => {},
  shouldDispatch: () => true,
};

/** 全部「成功」(放行后继)的简单跑法,记录完成顺序。 */
function recorder() {
  const order: string[] = [];
  const runNode = async (id: string) => {
    order.push(id);
    return "ok" as const;
  };
  return { order, runNode, advances: () => true };
}

// ── 核心:根治层屏障串行 ────────────────────────────────────────────────────

describe("runDataflow — 数据流(根治层屏障串行)", () => {
  it("独立两链:快链不被慢链拖住(D1 卡住时 A 链照样全跑完)", async () => {
    // A1→A2→A3(快); D1→D2→D3(D1 人为卡住)。
    // 层屏障下 A2 要等 D1(同层);数据流下 A 链全程不等 D。
    const order: string[] = [];
    const d1 = deferred();
    const runNode = async (id: string) => {
      if (id === "D1") {
        order.push("D1:start");
        await d1.promise;
        order.push("D1:end");
        return "ok";
      }
      order.push(id);
      return "ok";
    };
    const { adjacency, indegree } = graph(
      ["A1", "A2", "A3", "D1", "D2", "D3"],
      [["A1", "A2"], ["A2", "A3"], ["D1", "D2"], ["D2", "D3"]],
    );
    const p = runDataflow({
      nodes: ["A1", "A2", "A3", "D1", "D2", "D3"],
      adjacency,
      indegree,
      concurrency: 8,
      ...openGates,
      runNode,
      advances: () => true,
    });

    await flush();
    // A 链已整条跑完,完全不等 D。
    expect(order).toContain("A3");
    // D 链卡在 D1,D2 没开始。
    expect(order).toContain("D1:start");
    expect(order).not.toContain("D1:end");
    expect(order).not.toContain("D2");

    d1.resolve();
    await p;
    expect(order).toContain("D3"); // 放行后 D 链补完
  });

  it("钻石图 S→{A,B}→M:M 仅在 A、B 都完成后才跑", async () => {
    const order: string[] = [];
    const a = deferred();
    const b = deferred();
    const runNode = async (id: string) => {
      if (id === "A") await a.promise;
      if (id === "B") await b.promise;
      order.push(id);
      return "ok";
    };
    const { adjacency, indegree } = graph(
      ["S", "A", "B", "M"],
      [["S", "A"], ["S", "B"], ["A", "M"], ["B", "M"]],
    );
    const p = runDataflow({
      nodes: ["S", "A", "B", "M"],
      adjacency,
      indegree,
      concurrency: 8,
      ...openGates,
      runNode,
      advances: () => true,
    });

    await flush();
    expect(order).toEqual(["S"]); // A、B 都卡住
    a.resolve();
    await flush();
    expect(order).not.toContain("M"); // 只有 A 好,M 还不能跑
    b.resolve();
    await p;
    expect(order[order.length - 1]).toBe("M"); // A、B 齐了才跑 M
  });
});

// ── 失败隔离(advances=false 天然剪下游)─────────────────────────────────────

describe("runDataflow — advances 控制后继放行", () => {
  it("失败隔离:A 失败 → 下游闭包不跑,独立分支 C 照跑", async () => {
    const ran: string[] = [];
    const runNode = async (id: string) => {
      ran.push(id);
      return id === "A" ? "failed" : "ok";
    };
    const { adjacency, indegree } = graph(
      ["A", "B", "C"],
      [["A", "B"]], // C 独立
    );
    const { results, notDispatched } = await runDataflow({
      nodes: ["A", "B", "C"],
      adjacency,
      indegree,
      concurrency: 8,
      ...openGates,
      runNode,
      advances: (r) => r === "ok",
    });
    expect(ran).toContain("A");
    expect(ran).toContain("C"); // 独立分支照跑
    expect(ran).not.toContain("B"); // A 失败 → B 不放行
    expect(results.get("A")).toBe("failed");
    expect(notDispatched).toEqual(["B"]);
  });

  it("共用汇聚节点:某个前驱失败 → 汇聚节点不跑(需要全部前驱),另一前驱独立工作照跑", async () => {
    // A、B 共同汇聚到 M(indegree[M]=2)。A 失败 → 不放行 M;B 成功只把 M 减到 1 →
    // M 永不就绪 = 不跑(汇聚节点缺任一前驱就不该产垃圾)。B 本身照跑完。
    const ran: string[] = [];
    const runNode = async (id: string) => {
      ran.push(id);
      return id === "A" ? "failed" : "ok";
    };
    const { adjacency, indegree } = graph(
      ["A", "B", "M"],
      [["A", "M"], ["B", "M"]],
    );
    const { results, notDispatched } = await runDataflow({
      nodes: ["A", "B", "M"],
      adjacency,
      indegree,
      concurrency: 8,
      ...openGates,
      runNode,
      advances: (r) => r === "ok",
    });
    expect(ran.sort()).toEqual(["A", "B"]); // A、B 都跑;M 没跑
    expect(ran).not.toContain("M");
    expect(results.get("A")).toBe("failed");
    expect(results.get("B")).toBe("ok");
    expect(notDispatched).toEqual(["M"]); // 汇聚节点缺一个前驱 → 永不就绪
  });

  it("共用汇聚节点:全部前驱成功 → 汇聚节点恰好跑一次(不因多前驱重复跑)", async () => {
    // 双钻石 {A,B}→X→{C,D}:X 被两条路径共用,只应跑一次。
    const runs = new Map<string, number>();
    const runNode = async (id: string) => {
      runs.set(id, (runs.get(id) ?? 0) + 1);
      return "ok";
    };
    const { adjacency, indegree } = graph(
      ["A", "B", "X", "C", "D"],
      [["A", "X"], ["B", "X"], ["X", "C"], ["X", "D"]],
    );
    const { results } = await runDataflow({
      nodes: ["A", "B", "X", "C", "D"],
      adjacency,
      indegree,
      concurrency: 8,
      ...openGates,
      runNode,
      advances: () => true,
    });
    expect(runs.get("X")).toBe(1); // 关键:共用节点只跑一次
    expect(results.size).toBe(5); // 全部都跑到
  });
});

// ── 停止 / 暂停闸 ────────────────────────────────────────────────────────────

describe("runDataflow — 停止 / 暂停闸", () => {
  it("停止闸:停止后不再派发新节点,已就绪未起跑的归 notDispatched", async () => {
    const ran: string[] = [];
    let stop = false;
    const runNode = async (id: string) => {
      ran.push(id);
      if (id === "A") stop = true; // A 跑时请求停止
      return "ok";
    };
    // A、B、C 独立(都就绪),并发=1 → A 先跑,跑时停止 → B、C 不再派发。
    const { adjacency, indegree } = graph(["A", "B", "C"], []);
    const { notDispatched } = await runDataflow({
      nodes: ["A", "B", "C"],
      adjacency,
      indegree,
      concurrency: 1,
      gate: async () => {},
      shouldDispatch: () => !stop,
      runNode,
      advances: () => true,
    });
    expect(ran).toEqual(["A"]);
    expect(notDispatched.sort()).toEqual(["B", "C"]);
  });

  it("停止闸:在途(已起跑)的并发节点放它跑完,不误杀", async () => {
    const ran: string[] = [];
    let stop = false;
    const runNode = async (id: string) => {
      ran.push(id);
      // 模拟 runCard 的异步:停止信号在一次 await 之后才落 —— 此时同 tick 起跑的 C 已过派发闸。
      await Promise.resolve();
      if (id === "A") stop = true;
      return "ok";
    };
    // 并发=∞:A、C 同 tick 起跑;A 跑时停止,但 C 已在途 → 跑完。
    const { adjacency, indegree } = graph(["A", "C"], []);
    const { results } = await runDataflow({
      nodes: ["A", "C"],
      adjacency,
      indegree,
      concurrency: Infinity,
      gate: async () => {},
      shouldDispatch: () => !stop,
      runNode,
      advances: () => true,
    });
    expect(ran.sort()).toEqual(["A", "C"]); // C 在途跑完
    expect(results.size).toBe(2);
  });

  it("暂停闸:gate 挂起期间不落定任何节点,放行后跑完", async () => {
    const ran: string[] = [];
    const pause = deferred();
    let paused = true;
    const runNode = async (id: string) => {
      ran.push(id);
      return "ok";
    };
    const p = runDataflow({
      nodes: ["A", "B"],
      ...graph(["A", "B"], [["A", "B"]]),
      concurrency: 8,
      gate: async () => {
        if (paused) await pause.promise;
      },
      shouldDispatch: () => true,
      runNode,
      advances: () => true,
    });
    await flush();
    expect(ran).toEqual([]); // 暂停中,一个都没起跑
    paused = false;
    pause.resolve();
    await p;
    expect(ran).toEqual(["A", "B"]);
  });
});

// ── 并发上限 / 确定性 / 边界 ─────────────────────────────────────────────────

describe("runDataflow — 并发上限 / 确定性 / 边界", () => {
  it("峰值并发不超过 concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const gates = ["A", "B", "C", "D", "E"].map(() => deferred());
    const idx = new Map(["A", "B", "C", "D", "E"].map((id, i) => [id, i]));
    const runNode = async (id: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await gates[idx.get(id)!]!.promise;
      inFlight--;
      return "ok";
    };
    const p = runDataflow({
      nodes: ["A", "B", "C", "D", "E"],
      ...graph(["A", "B", "C", "D", "E"], []), // 全独立,5 个都就绪
      concurrency: 2,
      ...openGates,
      runNode,
      advances: () => true,
    });
    await flush();
    expect(peak).toBe(2); // 5 个就绪但只起 2 个
    gates.forEach((g) => g.resolve());
    await p;
    expect(peak).toBe(2);
  });

  it("确定性:并发=1 时按 id 字典序在依赖允许下派发", async () => {
    const { order, runNode, advances } = recorder();
    // 边:A→C。就绪初始 = A、B、D(C 等 A)。并发=1 应得 A,B,C,D(B、D 按 id 序)。
    const res = await runDataflow({
      nodes: ["A", "B", "C", "D"],
      ...graph(["A", "B", "C", "D"], [["A", "C"]]),
      concurrency: 1,
      ...openGates,
      runNode,
      advances,
    });
    expect(order).toEqual(["A", "B", "C", "D"]);
    expect(res.notDispatched).toEqual([]);
  });

  it("空图:立即收尾,无结果", async () => {
    const { runNode, advances } = recorder();
    const res = await runDataflow({
      nodes: [],
      adjacency: new Map(),
      indegree: new Map(),
      concurrency: 8,
      ...openGates,
      runNode,
      advances,
    });
    expect(res.results.size).toBe(0);
    expect(res.notDispatched).toEqual([]);
  });

  it("环漏入(入度永不归零):不挂死,环上节点归 notDispatched", async () => {
    const { order, runNode, advances } = recorder();
    // X→Y→X 环 + 独立 Z。X、Y 入度恒 ≥1 永不就绪;Z 正常跑。
    const adjacency = new Map<string, string[]>([
      ["X", ["Y"]],
      ["Y", ["X"]],
    ]);
    const indegree = new Map<string, number>([
      ["X", 1],
      ["Y", 1],
      ["Z", 0],
    ]);
    const res = await runDataflow({
      nodes: ["X", "Y", "Z"],
      adjacency,
      indegree,
      concurrency: 8,
      ...openGates,
      runNode,
      advances,
    });
    expect(order).toEqual(["Z"]);
    expect(res.notDispatched.sort()).toEqual(["X", "Y"]);
  });
});
