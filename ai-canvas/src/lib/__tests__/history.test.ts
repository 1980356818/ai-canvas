/**
 * 撤销 / 重做 —— 组(Frame)历史 + transact 原子事务。
 *
 * 重点验证用户报的两个错位场景:
 *   1. 复制粘贴一个组后 Ctrl+Z → 卡和组**一起**消失(不再「卡没了组还在」)。
 *   2. 移框后 Ctrl+Z → 卡坐标和框边界**一起**回原位(不再「卡回去了框没动」)。
 *
 * 只 mock 触达 IO 的 @/platform 与 @/lib/autoSave;stores 与 frameMembership 用真实实现
 * (node 环境可确定执行),以便顺带验证「撤销后由 reconcile 重算成员」这条契约成立。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/platform", () => ({
  deleteCard: vi.fn(async () => {}),
  deleteGroup: vi.fn(async () => {}),
  saveGroupsBatch: vi.fn(async () => {}),
}));

vi.mock("@/lib/autoSave", () => ({
  autoSave: {
    markDirty: vi.fn(),
    markGroupDirty: vi.fn(),
    forceSave: vi.fn(async () => {}),
  },
}));

import {
  history,
  recordUpdate,
  recordBatchCreate,
  recordGroupCreate,
  recordGroupDelete,
  recordGroupUpdate,
} from "@/lib/history";
import { useCardStore } from "@/stores/cardStore";
import { useGroupStore } from "@/stores/groupStore";
import { useProjectStore } from "@/stores/projectStore";
import type { CanvasCard, CardGroup } from "@/types";

const P = "proj-h";

function mkCard(id: string, x: number, y: number, w = 200, h = 120): CanvasCard {
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

beforeEach(() => {
  useCardStore.getState().setCards([]);
  useGroupStore.getState().setGroups([]);
  useProjectStore.getState().setCurrentProjectId(P);
  history.clear();
});

describe("组历史:create / delete / update", () => {
  it("撤销组创建 → 组被删除", () => {
    useGroupStore.getState().addGroup(mkFrame("g", { x: 0, y: 0, width: 300, height: 300 }));
    recordGroupCreate("g");

    history.undo();
    expect(useGroupStore.getState().getGroup("g")).toBeUndefined();
  });

  it("重做组创建 → 组回来", () => {
    useGroupStore.getState().addGroup(mkFrame("g", { x: 0, y: 0, width: 300, height: 300 }));
    recordGroupCreate("g");

    history.undo();
    expect(useGroupStore.getState().getGroup("g")).toBeUndefined();
    history.redo();
    expect(useGroupStore.getState().getGroup("g")).toBeDefined();
  });

  it("撤销解组 → 组按快照建回(含成员 / 边界)", () => {
    useCardStore.getState().setCards([mkCard("a", 50, 50), mkCard("b", 100, 100)]);
    const g = mkFrame("g", { x: 10, y: 20, width: 300, height: 300 }, ["a", "b"]);
    useGroupStore.getState().addGroup(g);

    // 解组
    recordGroupDelete(g);
    useGroupStore.getState().removeGroup("g");
    expect(useGroupStore.getState().getGroup("g")).toBeUndefined();

    history.undo();
    const restored = useGroupStore.getState().getGroup("g");
    expect(restored).toBeDefined();
    expect([...restored!.cardIds].sort()).toEqual(["a", "b"]);
    expect(restored!.x).toBe(10);
    expect(restored!.y).toBe(20);
  });

  it("撤销移框 → 框边界还原(仅几何;成员由 reconcile 重算)", () => {
    useCardStore.getState().setCards([mkCard("a", 50, 50)]);
    useGroupStore.getState().addGroup(mkFrame("g", { x: 0, y: 0, width: 300, height: 300 }, ["a"]));

    recordGroupUpdate("g", { x: 0, y: 0 });
    useGroupStore.getState().updateGroup("g", { x: 500, y: 500 });
    expect(useGroupStore.getState().getGroup("g")!.x).toBe(500);

    history.undo();
    expect(useGroupStore.getState().getGroup("g")!.x).toBe(0);
    expect(useGroupStore.getState().getGroup("g")!.y).toBe(0);
  });
});

describe("transact:卡 + 组合成一次原子撤销", () => {
  it("撤销粘贴整组 → 卡和组一起消失(一次 Ctrl+Z)", () => {
    // 模拟 materialize:加卡 + 加组,transact 记录成一步
    useCardStore.getState().addCard(mkCard("a", 50, 50));
    useCardStore.getState().addCard(mkCard("b", 100, 100));
    useGroupStore.getState().addGroup(mkFrame("g", { x: 0, y: 0, width: 300, height: 300 }, ["a", "b"]));

    history.transact(() => {
      recordBatchCreate(["a", "b"]);
      recordGroupCreate("g");
    });

    history.undo();
    expect(useCardStore.getState().getCard("a")).toBeUndefined();
    expect(useCardStore.getState().getCard("b")).toBeUndefined();
    expect(useGroupStore.getState().getGroup("g")).toBeUndefined(); // 组不再残留
  });

  it("撤销移框 → 卡坐标和框边界一起回原位(一次 Ctrl+Z)", () => {
    useCardStore.getState().setCards([mkCard("a", 50, 50)]);
    useGroupStore.getState().addGroup(mkFrame("g", { x: 0, y: 0, width: 300, height: 300 }, ["a"]));

    // 模拟 useGroupTitleDrag 落手:卡 +500,+500、框 +500,+500,合成一步
    history.transact(() => {
      recordUpdate("a", { x: 50, y: 50 });
      recordGroupUpdate("g", { x: 0, y: 0 });
    });
    useCardStore.getState().updateCard("a", { x: 550, y: 550 });
    useGroupStore.getState().updateGroup("g", { x: 500, y: 500 });

    history.undo();
    expect(useCardStore.getState().getCard("a")!.x).toBe(50); // 卡回原位
    expect(useGroupStore.getState().getGroup("g")!.x).toBe(0); // 框也回原位
  });

  it("空事务不入栈", () => {
    history.transact(() => {
      /* 什么都不 record */
    });
    expect(history.canUndo()).toBe(false);
  });
});
