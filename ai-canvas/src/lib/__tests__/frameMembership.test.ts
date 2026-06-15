import { describe, it, expect, beforeEach } from "vitest";
import { reconcileFrameMembership, cardsInFrame } from "@/lib/frameMembership";
import { useCardStore } from "@/stores/cardStore";
import { useGroupStore } from "@/stores/groupStore";
import type { CanvasCard, CardGroup } from "@/types";

const P = "proj-1";

function mkCard(id: string, x: number, y: number, w = 100, h = 100): CanvasCard {
  return {
    id,
    projectId: P,
    type: "text",
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
  };
}

function mkFrame(
  id: string,
  rect: { x: number; y: number; width: number; height: number },
  cardIds: string[] = [],
  collapsed = false,
): CardGroup {
  return {
    id,
    projectId: P,
    cardIds,
    title: id,
    color: "#7C3AED",
    collapsed,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    createdAt: "t0",
    updatedAt: "t0",
  };
}

const idsOf = (gid: string) =>
  [...(useGroupStore.getState().getGroup(gid)?.cardIds ?? [])].sort();

beforeEach(() => {
  useCardStore.getState().setCards([]);
  useGroupStore.getState().setGroups([]);
});

describe("cardsInFrame", () => {
  it("命中 = 卡片中心点落在 rect 内(闭区间)", () => {
    const cards = new Map<string, CanvasCard>([
      ["in", mkCard("in", 50, 50)], // center (100,100) ∈
      ["out", mkCard("out", 400, 400)], // center (450,450) ∉
    ]);
    const hit = cardsInFrame({ x: 0, y: 0, width: 300, height: 300 }, cards);
    expect(hit).toEqual(["in"]);
  });
});

describe("reconcileFrameMembership", () => {
  it("把框内的非成员卡吸收进来,框外的不动(空间即真相)", () => {
    // A 初始是成员;B 落在框内但不是成员(模拟导入掉组);C 在框外。
    useCardStore.getState().setCards([
      mkCard("A", 50, 50), // center (100,100) ∈
      mkCard("B", 150, 150), // center (200,200) ∈
      mkCard("C", 400, 400), // center (450,450) ∉
    ]);
    useGroupStore
      .getState()
      .setGroups([mkFrame("F", { x: 0, y: 0, width: 300, height: 300 }, ["A"])]);

    const changed = reconcileFrameMembership(P);

    expect(changed).toBe(true);
    expect(idsOf("F")).toEqual(["A", "B"]); // B 被吸收,C 不在
  });

  it("重叠框:卡片归属最上层(渲染顺序靠后)的框", () => {
    useCardStore.getState().setCards([mkCard("X", 150, 150)]); // center (200,200)
    useGroupStore.getState().setGroups([
      mkFrame("F1", { x: 0, y: 0, width: 300, height: 300 }), // 底层
      mkFrame("F2", { x: 100, y: 100, width: 300, height: 300 }), // 顶层(后绘制)
    ]);

    reconcileFrameMembership(P);

    expect(idsOf("F2")).toEqual(["X"]);
    expect(idsOf("F1")).toEqual([]);
  });

  it("折叠框冻结:成员不变,且其成员不被其它框吸走;框内非冻结卡仍按空间归属", () => {
    useCardStore.getState().setCards([
      mkCard("A", 20, 20), // 折叠框 FC 的冻结成员,几何上也落在展开框 FE 内
      mkCard("B", 60, 60), // 自由卡,落在 FE 内
    ]);
    useGroupStore.getState().setGroups([
      mkFrame("FC", { x: 0, y: 0, width: 200, height: 200 }, ["A"], true), // 折叠
      mkFrame("FE", { x: 0, y: 0, width: 400, height: 400 }), // 展开,覆盖 A 和 B
    ]);

    reconcileFrameMembership(P);

    expect(idsOf("FC")).toEqual(["A"]); // 折叠框成员冻结
    expect(idsOf("FE")).toEqual(["B"]); // 只吸收自由卡 B,不抢冻结的 A
  });

  it("成员移出框 → 自动出组,空框保留(不删除)", () => {
    useCardStore.getState().setCards([mkCard("A", 500, 500)]); // center 远在框外
    useGroupStore
      .getState()
      .setGroups([mkFrame("F", { x: 0, y: 0, width: 100, height: 100 }, ["A"])]);

    reconcileFrameMembership(P);

    expect(idsOf("F")).toEqual([]); // A 出组
    expect(useGroupStore.getState().getGroup("F")).toBeDefined(); // 空框仍在
  });
});
