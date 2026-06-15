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

function makePlan(
  partial: Partial<RunPlan> & { groupId: string; layers: string[][] },
): RunPlan {
  const total = partial.layers.reduce((s, l) => s + l.length, 0);
  return {
    groupId: partial.groupId,
    layers: partial.layers,
    total,
    concurrency: partial.concurrency ?? Infinity,
    adjacency: partial.adjacency ?? new Map(),
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

describe("executePlan — 调度 + 终结态", () => {
  it("全部成功 → completed,ok 计数 + 状态机 completed", async () => {
    mockRunCard.mockResolvedValue({ outcome: "ok" });
    const report = await executePlan(
      makePlan({ groupId: "g1", layers: [["A"], ["B"]] }),
      new GroupRunControl(),
    );
    expect(report.endState).toBe("completed");
    expect(report.ok).toBe(2);
    expect(report.notDispatched).toBe(0);
    expect(phaseOf("g1")).toBe("completed");
    expect(mockRunCard).toHaveBeenCalledTimes(2);
  });

  it("skipped 计入 done(不计 failed),全跳过仍 completed", async () => {
    mockRunCard.mockResolvedValue({ outcome: "skipped", reason: "text 节点" });
    const report = await executePlan(
      makePlan({ groupId: "g5", layers: [["A", "B"]] }),
      new GroupRunControl(),
    );
    expect(report.skipped).toBe(2);
    expect(report.failed).toBe(0);
    expect(report.endState).toBe("completed");
  });

  it("失败隔离:失败卡的下游剪枝(notDispatched),独立分支照跑", async () => {
    mockRunCard.mockImplementation(async (cid) =>
      cid === "A" ? { outcome: "failed", reason: "boom" } : { outcome: "ok" },
    );
    // A→B(B 是 A 下游),C 独立。layer0=[A,C],layer1=[B]。A 失败 → B 剪枝,C 照跑。
    const adjacency = new Map<string, string[]>([["A", ["B"]]]);
    const report = await executePlan(
      makePlan({ groupId: "g2", layers: [["A", "C"], ["B"]], adjacency }),
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

  it("排空式停止(闸门①层间):停止后续层不派发,在途跑完 → stopped", async () => {
    const ctrl = new GroupRunControl();
    // A 在途时用户点停止 → 下一层 B 不该开
    mockRunCard.mockImplementation(async (cid) => {
      if (cid === "A") ctrl.requestStop();
      return { outcome: "ok" };
    });
    const report = await executePlan(
      makePlan({ groupId: "g3", layers: [["A"], ["B"]] }),
      ctrl,
    );
    expect(report.endState).toBe("stopped");
    expect(report.ok).toBe(1); // A(在途)跑完
    expect(report.notDispatched).toBe(1); // B
    expect(phaseOf("g3")).toBe("stopped");
    expect(mockRunCard).toHaveBeenCalledTimes(1);
  });

  it("排空式停止(闸门②层内,并发=1):本层没轮到的卡不调 runCard(不扣费)", async () => {
    const ctrl = new GroupRunControl();
    // 同层 [A,B] 并发=1 顺序:A 跑时停止 → B 的 thunk 被闸门②拦下,runCard 不调
    mockRunCard.mockImplementation(async (cid) => {
      if (cid === "A") ctrl.requestStop();
      return { outcome: "ok" };
    });
    const report = await executePlan(
      makePlan({ groupId: "g4", layers: [["A", "B"]], concurrency: 1 }),
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
      makePlan({ groupId: "g6", layers: [["A"]] }),
      ctrl,
    );
    // forceAbort 后闸门②直接拦下(shouldDispatch=false),A 不派发 → runCard 没被调
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
      makePlan({ groupId: "gr1", layers: [["A", "B"]], mode: "resume" }),
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
      makePlan({ groupId: "gr2", layers: [["A"]], mode: "resume" }),
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
      makePlan({ groupId: "gr-retry", layers: [["A"]], maxRetries: 2, retryBackoffMs: 0 }),
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
      makePlan({ groupId: "gr-noretry", layers: [["A"]], maxRetries: 2, retryBackoffMs: 0 }),
      new GroupRunControl(),
    );
    expect(calls).toBe(1); // 永久错误不重试
    expect(report.failed).toBe(1);
  });
});
