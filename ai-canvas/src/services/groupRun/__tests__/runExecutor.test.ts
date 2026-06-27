import { describe, it, expect, vi, beforeEach } from "vitest";

// runCard 拉一长串 provider/taskManager 依赖,node 下 mock 掉,只控制 outcome。
vi.mock("@/services/cardRunner", () => ({ runCard: vi.fn() }));

import { executePlan } from "../runExecutor";
import { GroupRunControl } from "../runController";
import { runCard } from "@/services/cardRunner";
import { useCardStore } from "@/stores/cardStore";
import { useGroupRunStatusStore } from "@/stores/groupRunStatusStore";
import { runInputFingerprint } from "@/services/generation/runInputs";
import type { RunPlan } from "../runPlan";
import type { CanvasCard } from "@/types";

function canvasCard(id: string, data: Record<string, unknown>): CanvasCard {
  return {
    id,
    projectId: "p",
    type: "ai_image",
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    zIndex: 1,
    locked: false,
    collapsed: false,
    title: undefined,
    data,
    createdAt: "t",
    updatedAt: "t",
  } as CanvasCard;
}

const mockRunCard = vi.mocked(runCard);

/**
 * 从 `nodes` + `edges` 造一份 plan(数据流形态)。
 * adjacency / indegree 由 edges 推导(限定在 nodes 内),与 buildRunPlan 同口径。
 * 说明:旧版用「人工 layers」隐式表达「先后/独立」;数据流下这些必须落到**真实的边或并发数**上。
 */
function makePlan(
  partial: {
    groupId: string;
    nodes: string[];
    edges?: [string, string][];
  } & Partial<Pick<RunPlan, "concurrency" | "mode" | "maxRetries" | "retryBackoffMs">>,
): RunPlan {
  const edges = partial.edges ?? [];
  const nodeSet = new Set(partial.nodes);
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of partial.nodes) indegree.set(id, 0);
  for (const [s, t] of edges) {
    if (!nodeSet.has(s) || !nodeSet.has(t)) continue;
    (adjacency.get(s) ?? adjacency.set(s, []).get(s)!).push(t);
    indegree.set(t, (indegree.get(t) ?? 0) + 1);
  }
  return {
    groupId: partial.groupId,
    nodes: [...partial.nodes].sort(),
    total: partial.nodes.length,
    concurrency: partial.concurrency ?? Infinity,
    adjacency,
    indegree,
    mode: partial.mode ?? "rerun",
    maxRetries: partial.maxRetries ?? 0,
    retryBackoffMs: partial.retryBackoffMs ?? 0,
  };
}

const phaseOf = (gid: string) =>
  useGroupRunStatusStore.getState().runningGroups.get(gid)?.phase;

beforeEach(() => {
  mockRunCard.mockReset();
  useCardStore.getState().setCards([]); // 隔离:避免上个用例的卡污染 resume 新鲜度判定
});

describe("executePlan — 数据流调度 + 终结态", () => {
  it("全部成功 → completed,ok 计数 + 状态机 completed", async () => {
    mockRunCard.mockResolvedValue({ outcome: "ok" });
    const report = await executePlan(
      makePlan({ groupId: "g1", nodes: ["A", "B"], edges: [["A", "B"]] }),
      new GroupRunControl(),
    );
    expect(report.endState).toBe("completed");
    expect(report.ok).toBe(2);
    expect(report.notDispatched).toBe(0);
    expect(phaseOf("g1")).toBe("completed");
    expect(mockRunCard).toHaveBeenCalledTimes(2);
  });

  it("两条独立链各自跑完(根治层屏障:互不阻塞)", async () => {
    mockRunCard.mockResolvedValue({ outcome: "ok" });
    // A1→A2 与 B1→B2 完全独立。数据流下两链各自推进,4 张全 ok。
    const report = await executePlan(
      makePlan({
        groupId: "g-indep",
        nodes: ["A1", "A2", "B1", "B2"],
        edges: [["A1", "A2"], ["B1", "B2"]],
      }),
      new GroupRunControl(),
    );
    expect(report.ok).toBe(4);
    expect(report.endState).toBe("completed");
    expect(mockRunCard).toHaveBeenCalledTimes(4);
  });

  it("skipped 计入 done(不计 failed),全跳过仍 completed", async () => {
    mockRunCard.mockResolvedValue({ outcome: "skipped", reason: "text 节点" });
    const report = await executePlan(
      makePlan({ groupId: "g5", nodes: ["A", "B"] }), // 独立两根
      new GroupRunControl(),
    );
    expect(report.skipped).toBe(2);
    expect(report.failed).toBe(0);
    expect(report.endState).toBe("completed");
  });

  it("失败隔离:失败卡的下游不放行(notDispatched),独立分支照跑", async () => {
    mockRunCard.mockImplementation(async (cid) =>
      cid === "A" ? { outcome: "failed", reason: "boom" } : { outcome: "ok" },
    );
    // A→B(B 是 A 下游),C 独立。A 失败 → B 不放行(下游天然不就绪 = 剪枝),C 照跑。
    const report = await executePlan(
      makePlan({ groupId: "g2", nodes: ["A", "B", "C"], edges: [["A", "B"]] }),
      new GroupRunControl(),
    );
    expect(report.failed).toBe(1); // A
    expect(report.ok).toBe(1); // C 独立分支照跑完
    expect(report.notDispatched).toBe(1); // B 被剪枝(没派发,没扣费)
    expect(report.firstFailure?.cardId).toBe("A");
    expect(report.endState).toBe("failed");
    expect(phaseOf("g2")).toBe("failed");
    expect(mockRunCard).toHaveBeenCalledWith("C", expect.anything());
    expect(mockRunCard).not.toHaveBeenCalledWith("B", expect.anything());
  });

  it("排空式停止:停止后下游不派发,在途跑完 → stopped", async () => {
    const ctrl = new GroupRunControl();
    // A→B。A 在途时用户点停止 → A 完成也不放行派发 B。
    mockRunCard.mockImplementation(async (cid) => {
      if (cid === "A") ctrl.requestStop();
      return { outcome: "ok" };
    });
    const report = await executePlan(
      makePlan({ groupId: "g3", nodes: ["A", "B"], edges: [["A", "B"]] }),
      ctrl,
    );
    expect(report.endState).toBe("stopped");
    expect(report.ok).toBe(1); // A(在途)跑完
    expect(report.notDispatched).toBe(1); // B
    expect(phaseOf("g3")).toBe("stopped");
    expect(mockRunCard).toHaveBeenCalledTimes(1);
  });

  it("排空式停止(并发=1):没轮到的卡不调 runCard(不扣费)", async () => {
    const ctrl = new GroupRunControl();
    // 两根 [A,B] 并发=1:A 先跑时停止 → B 在派发闸被拦,runCard 不调。
    mockRunCard.mockImplementation(async (cid) => {
      if (cid === "A") ctrl.requestStop();
      return { outcome: "ok" };
    });
    const report = await executePlan(
      makePlan({ groupId: "g4", nodes: ["A", "B"], concurrency: 1 }),
      ctrl,
    );
    expect(report.endState).toBe("stopped");
    expect(report.ok).toBe(1);
    expect(report.notDispatched).toBe(1);
    expect(mockRunCard).toHaveBeenCalledTimes(1); // 关键:B 没过提交咽喉
    expect(mockRunCard).toHaveBeenCalledWith("A", expect.anything());
  });

  it("强制中止:control.signal 透传进 runCard 且已 abort", async () => {
    const ctrl = new GroupRunControl();
    let seenAborted: boolean | null = null;
    mockRunCard.mockImplementation(async (_cid, opts) => {
      seenAborted = opts?.signal?.aborted ?? null;
      return { outcome: "ok" };
    });
    ctrl.forceAbort(); // 跑之前就强制中止
    const report = await executePlan(
      makePlan({ groupId: "g6", nodes: ["A"] }),
      ctrl,
    );
    // forceAbort 后派发闸直接拦下(shouldDispatch=false),A 不派发 → runCard 没被调
    expect(report.notDispatched).toBe(1);
    expect(report.endState).toBe("stopped");
    expect(seenAborted).toBeNull(); // 没进 runCard
  });

  it("resume:新鲜卡跳过(不调 runCard),非新鲜卡照跑", async () => {
    mockRunCard.mockResolvedValue({ outcome: "ok" });
    // A 盖了与当前输入匹配的已确认戳 → 新鲜;B 无戳 → 必跑。
    const aData = { model: "gpt-image-2", content: "a cat" };
    const aFp = runInputFingerprint(canvasCard("A", aData));
    const freshA = canvasCard("A", {
      ...aData,
      _run: { fp: aFp, at: "t", pending: false },
    });
    const bCard = canvasCard("B", { model: "gpt-image-2", content: "a dog" });
    useCardStore.getState().setCards([freshA, bCard]);

    const report = await executePlan(
      makePlan({ groupId: "gr1", nodes: ["A", "B"], mode: "resume" }),
      new GroupRunControl(),
    );
    expect(report.skipped).toBe(1); // A 新鲜 → 跳过
    expect(report.ok).toBe(1); // B → 跑了
    expect(mockRunCard).toHaveBeenCalledTimes(1);
    expect(mockRunCard).toHaveBeenCalledWith("B", expect.anything());
    expect(report.endState).toBe("completed");
  });

  it("resume:全部新鲜 → 一个都不跑(ok=0,全 skipped)", async () => {
    mockRunCard.mockResolvedValue({ outcome: "ok" });
    const data = { model: "gpt-image-2", content: "x" };
    const fp = runInputFingerprint(canvasCard("A", data));
    const fresh = canvasCard("A", { ...data, _run: { fp, at: "t", pending: false } });
    useCardStore.getState().setCards([fresh]);
    const report = await executePlan(
      makePlan({ groupId: "gr2", nodes: ["A"], mode: "resume" }),
      new GroupRunControl(),
    );
    expect(report.ok).toBe(0);
    expect(report.skipped).toBe(1);
    expect(mockRunCard).not.toHaveBeenCalled();
  });

  it("重试:可重试失败(429)退避后重试成功", async () => {
    let calls = 0;
    mockRunCard.mockImplementation(async () => {
      calls++;
      return calls === 1
        ? { outcome: "failed" as const, reason: "429 too many requests" }
        : { outcome: "ok" as const };
    });
    const report = await executePlan(
      makePlan({ groupId: "gr-retry", nodes: ["A"], maxRetries: 2, retryBackoffMs: 0 }),
      new GroupRunControl(),
    );
    expect(calls).toBe(2); // 失败一次 + 重试一次
    expect(report.ok).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.endState).toBe("completed");
  });

  it("重试:不可重试失败(内容拦截)直接失败,不重试(不重复扣费)", async () => {
    let calls = 0;
    mockRunCard.mockImplementation(async () => {
      calls++;
      return { outcome: "failed" as const, reason: "content policy violation" };
    });
    const report = await executePlan(
      makePlan({ groupId: "gr-noretry", nodes: ["A"], maxRetries: 2, retryBackoffMs: 0 }),
      new GroupRunControl(),
    );
    expect(calls).toBe(1); // 永久错误不重试
    expect(report.failed).toBe(1);
  });
});
