import { describe, it, expect } from "vitest";
import { buildRunPlan, type RunPlan } from "../runPlan";

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
