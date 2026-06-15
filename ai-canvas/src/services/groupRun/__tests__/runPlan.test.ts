import { describe, it, expect, beforeEach } from "vitest";
import { buildRunPlan, planGroupRun, type RunPlan } from "../runPlan";
import { useCardStore } from "@/stores/cardStore";
import { useGroupStore } from "@/stores/groupStore";
import { useConnectionStore } from "@/stores/connectionStore";
import type { CanvasCard, CardGroup } from "@/types";

/** 断言 plan 成功并收窄类型。 */
function okPlan(r: ReturnType<typeof buildRunPlan>): RunPlan & { ok: true } {
  expect(r.ok).toBe(true);
  return r as RunPlan & { ok: true };
}

describe("buildRunPlan — 纯函数规划", () => {
  it("线性链 A→B→C:三层、每层一张、total=3", () => {
    const r = okPlan(
      buildRunPlan(
        "g",
        ["A", "B", "C"],
        [
          ["A", "B"],
          ["B", "C"],
        ],
        { startSet: null, mode: "rerun", concurrency: Infinity },
      ),
    );
    expect(r.layers).toEqual([["A"], ["B"], ["C"]]);
    expect(r.total).toBe(3);
    expect(r.mode).toBe("rerun");
    expect(r.concurrency).toBe(Infinity);
  });

  it("两条独立链 A→B、C→D:同层并发 [[A,C],[B,D]]、total=4", () => {
    const r = okPlan(
      buildRunPlan(
        "g",
        ["A", "B", "C", "D"],
        [
          ["A", "B"],
          ["C", "D"],
        ],
        { startSet: null, mode: "rerun", concurrency: 8 },
      ),
    );
    // topoSort 同层按 id 字典序排
    expect(r.layers).toEqual([
      ["A", "C"],
      ["B", "D"],
    ]);
    expect(r.total).toBe(4);
    expect(r.concurrency).toBe(8);
  });

  it("成环 A→B→A:返回 cycle 拒绝,带参与环的节点", () => {
    const r = buildRunPlan(
      "g",
      ["A", "B"],
      [
        ["A", "B"],
        ["B", "A"],
      ],
      { startSet: null, mode: "rerun", concurrency: Infinity },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("cycle");
      expect(r.cycleNodes?.sort()).toEqual(["A", "B"]);
    }
  });

  it("部分运行 startSet={B}:只取 B + 其后继 C(A 被过滤掉),total=2", () => {
    const r = okPlan(
      buildRunPlan(
        "g",
        ["A", "B", "C"],
        [
          ["A", "B"],
          ["B", "C"],
        ],
        { startSet: new Set(["B"]), mode: "rerun", concurrency: Infinity },
      ),
    );
    expect(r.layers).toEqual([["B"], ["C"]]);
    expect(r.total).toBe(2);
  });

  it("adjacency 正确建出组内子图正向邻接", () => {
    const r = okPlan(
      buildRunPlan(
        "g",
        ["A", "B", "C"],
        [
          ["A", "B"],
          ["A", "C"],
        ],
        { startSet: null, mode: "rerun", concurrency: Infinity },
      ),
    );
    expect(r.adjacency.get("A")?.sort()).toEqual(["B", "C"]);
    expect(r.adjacency.get("B")).toBeUndefined();
  });

  it("startSet 全不在节点集:过滤后空 → empty-range 拒绝", () => {
    const r = buildRunPlan(
      "g",
      ["A", "B"],
      [["A", "B"]],
      { startSet: new Set(["Z"]), mode: "rerun", concurrency: Infinity },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("empty-range");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// planGroupRun — 不纯边界:运行前按存储边界 reconcile 成员(空间即真相)。
// 回归:组运行漏跑「框里看得到、但不在 group.cardIds 派生缓存里」的卡。
// ───────────────────────────────────────────────────────────────────────────

const P = "proj-1";

function mkCard(id: string, x: number, y: number, w = 100, h = 100): CanvasCard {
  return {
    id,
    projectId: P,
    type: "ai_image",
    x,
    y,
    width: w,
    height: h,
    zIndex: 1,
    locked: false,
    collapsed: false,
    data: {},
    createdAt: "t0",
    updatedAt: "t0",
  } as CanvasCard;
}

function mkFrame(
  id: string,
  rect: { x: number; y: number; width: number; height: number },
  cardIds: string[] = [],
): CardGroup {
  return {
    id,
    projectId: P,
    cardIds,
    title: id,
    color: "#7C3AED",
    collapsed: false,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    createdAt: "t0",
    updatedAt: "t0",
  };
}

/** 计划里实际要跑的全部卡(layers 展平 + 排序),方便断言。 */
function plannedCards(gid: string): string[] {
  const plan = planGroupRun(gid);
  if (!plan.ok) throw new Error(`plan rejected: ${plan.reason}`);
  return plan.layers.flat().sort();
}

describe("planGroupRun — 运行前 reconcile 成员", () => {
  beforeEach(() => {
    useCardStore.getState().setCards([]);
    useGroupStore.getState().setGroups([]);
    useConnectionStore.getState().setConnections([]);
  });

  it("框内但不在 cardIds 的卡,运行前被纳入计划(根治组运行漏跑框内卡)", () => {
    // A 已是成员;B 中心落在框内但 cardIds 漏了它(模拟新建/粘贴/拖入未触发 reconcile)。
    useCardStore.getState().setCards([
      mkCard("A", 50, 50), // center (100,100) ∈ 框
      mkCard("B", 150, 150), // center (200,200) ∈ 框,但不在 cardIds
    ]);
    useGroupStore
      .getState()
      .setGroups([mkFrame("F", { x: 0, y: 0, width: 300, height: 300 }, ["A"])]);

    expect(plannedCards("F")).toEqual(["A", "B"]); // B 被运行前的 reconcile 吸收
    // 落库的派生缓存也已更新(下次几何提交不会回退)。
    expect(
      [...(useGroupStore.getState().getGroup("F")?.cardIds ?? [])].sort(),
    ).toEqual(["A", "B"]);
  });

  it("中心落在框外的卡不会被误纳入(不过度吸收)", () => {
    useCardStore.getState().setCards([
      mkCard("A", 50, 50), // center (100,100) ∈
      mkCard("C", 400, 400), // center (450,450) ∉
    ]);
    useGroupStore
      .getState()
      .setGroups([mkFrame("F", { x: 0, y: 0, width: 300, height: 300 }, ["A"])]);

    expect(plannedCards("F")).toEqual(["A"]); // C 在框外,不跑
  });

  it("成员被移出框后,运行前 reconcile 把它剔除(不再误跑出框卡)", () => {
    // cardIds 还挂着 A,但 A 几何上已移到框外 → 运行应只反映当前空间真相。
    useCardStore.getState().setCards([
      mkCard("A", 500, 500), // center 远在框外
      mkCard("B", 150, 150), // center (200,200) ∈
    ]);
    useGroupStore
      .getState()
      .setGroups([
        mkFrame("F", { x: 0, y: 0, width: 300, height: 300 }, ["A", "B"]),
      ]);

    expect(plannedCards("F")).toEqual(["B"]); // A 出框被剔除,只跑框内的 B
  });
});
