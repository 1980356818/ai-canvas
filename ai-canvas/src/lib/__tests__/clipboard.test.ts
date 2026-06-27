/**
 * 剪切(延迟删除)/ 复制 / 粘贴 的纯逻辑回归测试。
 *
 * 重点验证用户最担心的「数据丢失」场景:剪切一张卡后、在粘贴前又复制了别的内容,
 * 原卡绝不能丢 —— 延迟删除语义保证原卡一直留在画布上,直到一次成功粘贴(= 移动)。
 *
 * 只 mock 触达 Tauri/IO 的 `@/platform` 与 `@/lib/autoSave`;stores 用真实 zustand
 * 单例(node 环境可确定执行)。系统剪贴板用一个可变 holder 模拟。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.mock 工厂会被提升到 import 之前,这里用 vi.hoisted 造一个可变的「系统剪贴板」。
const h = vi.hoisted(() => ({ clip: { value: "" } }));

vi.mock("@/platform", () => ({
  clipboardWriteText: vi.fn(async (t: string) => {
    h.clip.value = t;
  }),
  clipboardReadText: vi.fn(async () => h.clip.value),
  updateProjectMeta: vi.fn(async () => {}),
  saveGroupsBatch: vi.fn(async () => {}),
  deleteGroup: vi.fn(async () => {}),
  deleteCard: vi.fn(async () => {}),
  saveCardsBatch: vi.fn(async () => {}),
}));

vi.mock("@/lib/autoSave", () => ({
  autoSave: { markDirty: vi.fn(), forceSave: vi.fn(async () => {}) },
}));

import { cutCards, copyCards, pasteCards } from "@/lib/clipboard";
import { history } from "@/lib/history";
import { useCardStore } from "@/stores/cardStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useGroupStore } from "@/stores/groupStore";
import { useProjectStore } from "@/stores/projectStore";
import type { CanvasCard } from "@/types";

function makeCard(id: string, x = 0, y = 0): CanvasCard {
  return {
    id,
    projectId: "p1",
    type: "ai_image",
    x,
    y,
    width: 200,
    height: 120,
    zIndex: 1,
    locked: false,
    collapsed: false,
    data: { imageUrl: `img-${id}` },
    createdAt: "t0",
    updatedAt: "t0",
  };
}

beforeEach(() => {
  h.clip.value = "";
  useCardStore.getState().clear();
  useConnectionStore.setState({ connections: new Map() });
  useGroupStore.setState({ groups: new Map() });
  useCanvasStore.getState().clearCutCards();
  useCanvasStore.getState().clearSelection();
  useProjectStore.getState().setCurrentProjectId("p1");
  history.clear();
});

describe("cutCards(延迟删除)", () => {
  it("剪切只标记待移动,不删除原卡,并写入快照", async () => {
    useCardStore.getState().addCard(makeCard("a"));
    const n = await cutCards(new Set(["a"]));
    expect(n).toBe(1);
    expect(useCanvasStore.getState().cutCardIds.has("a")).toBe(true);
    // 关键:原卡仍在画布上(延迟删除)
    expect(useCardStore.getState().getCard("a")).toBeDefined();
    expect(h.clip.value).toContain("ai-canvas-card");
  });

  it("剪切后再复制别的卡 → 取消这次剪切,原卡保留", async () => {
    useCardStore.getState().addCard(makeCard("a"));
    useCardStore.getState().addCard(makeCard("b", 500));
    await cutCards(new Set(["a"]));
    expect(useCanvasStore.getState().cutCardIds.has("a")).toBe(true);
    await copyCards(new Set(["b"]));
    expect(useCanvasStore.getState().cutCardIds.size).toBe(0);
    expect(useCardStore.getState().getCard("a")).toBeDefined();
  });
});

describe("用户担心的数据丢失场景", () => {
  it("剪切后复制外部图片(覆盖系统剪贴板)→ 原卡不丢,粘贴仍能完成移动", async () => {
    useCardStore.getState().addCard(makeCard("a", 0, 0));
    await cutCards(new Set(["a"]));

    // 模拟「因为一些原因复制了别的图片」:系统剪贴板被非卡片内容覆盖
    h.clip.value = "external clipboard junk, not an ai-canvas card";

    // 粘贴前:原卡必须仍然安全地待在画布上
    expect(useCardStore.getState().getCard("a")).toBeDefined();

    const newIds = await pasteCards("p1", { worldX: 300, worldY: 300 });

    expect(newIds.length).toBe(1);
    // 原卡被移走(移动语义),内容以新卡形式存在 → 没有任何丢失
    expect(useCardStore.getState().getCard("a")).toBeUndefined();
    expect(useCardStore.getState().getCard(newIds[0]!)).toBeDefined();
    // 总数不增不减:始终是这一张卡
    expect(useCardStore.getState().getCardsByProject("p1").length).toBe(1);
    expect(useCanvasStore.getState().cutCardIds.size).toBe(0);
  });
});

describe("剪切 → 粘贴 = 移动", () => {
  it("移动到落点,总数不变", async () => {
    useCardStore.getState().addCard(makeCard("a", 0, 0));
    await cutCards(new Set(["a"]));
    const newIds = await pasteCards("p1", { worldX: 400, worldY: 250 });
    expect(useCardStore.getState().getCardsByProject("p1").length).toBe(1);
    const moved = useCardStore.getState().getCard(newIds[0]!)!;
    // 落点居中:卡片中心对齐 (400,250) → 左上 = 中心 − 半宽高(200/2, 120/2)
    expect(moved.x).toBeCloseTo(300, 0);
    expect(moved.y).toBeCloseTo(190, 0);
  });

  it("移动后撤销 → 单步复原原卡 + 移除粘贴出的副本", async () => {
    useCardStore.getState().addCard(makeCard("a", 0, 0));
    await cutCards(new Set(["a"]));
    const newIds = await pasteCards("p1", { worldX: 400, worldY: 250 });
    expect(useCardStore.getState().getCard("a")).toBeUndefined();

    history.undo();
    expect(useCardStore.getState().getCard("a")).toBeDefined();
    expect(useCardStore.getState().getCard(newIds[0]!)).toBeUndefined();
    expect(useCardStore.getState().getCardsByProject("p1").length).toBe(1);
  });
});

describe("普通复制 → 粘贴 = 复制(回归,不受剪切改动影响)", () => {
  it("原卡保留,画布多出一份副本", async () => {
    useCardStore.getState().addCard(makeCard("a", 0, 0));
    await copyCards(new Set(["a"]));
    const newIds = await pasteCards("p1", { worldX: 300, worldY: 300 });
    expect(newIds.length).toBe(1);
    expect(useCardStore.getState().getCard("a")).toBeDefined();
    expect(useCardStore.getState().getCardsByProject("p1").length).toBe(2);
  });
});

describe("按组复制:副本避让源框(避免框叠框)", () => {
  it("整组复制粘贴 → 副本整体落在源右侧,水平不与源重叠", async () => {
    useCardStore.getState().addCard(makeCard("a", 0, 0)); // x: 0..200
    useCardStore.getState().addCard(makeCard("b", 300, 0)); // x: 300..500
    useGroupStore.getState().addGroup({
      id: "g1",
      projectId: "p1",
      cardIds: ["a", "b"],
      title: "工作流",
      color: "#7C3AED",
      collapsed: false,
      x: -16,
      y: -60,
      width: 532,
      height: 240,
      createdAt: "t0",
      updatedAt: "t0",
    });

    await copyCards(new Set(["a", "b"]));
    // 故意把落点设在源外接框正中(中心 (250,60))—— 旧逻辑会把整组叠在源上。
    const newIds = await pasteCards("p1", { worldX: 250, worldY: 60 });
    expect(newIds.length).toBe(2);

    // 副本最左 x > 源最右 x(500)→ 水平完全分离,两框不重叠。
    const newMinX = Math.min(
      ...newIds.map((id) => useCardStore.getState().getCard(id)!.x),
    );
    expect(newMinX).toBeGreaterThan(500);

    // 且确实生成了副本组(源组 + 副本组 = 2)。
    expect(useGroupStore.getState().getGroupsByProject("p1").length).toBe(2);
  });
});

describe("复制带「上游输入连线」(incoming)", () => {
  function connect(id: string, source: string, target: string) {
    useConnectionStore.getState().addConnection({
      id,
      projectId: "p1",
      sourceCardId: source,
      targetCardId: target,
      createdAt: "t0",
    });
  }

  it("复制单张下游卡 → 副本继承同样的上游输入连线", async () => {
    useCardStore.getState().addCard(makeCard("up", 0, 0));
    useCardStore.getState().addCard(makeCard("a", 300, 0));
    connect("c-up-a", "up", "a");

    await copyCards(new Set(["a"]));
    const newIds = await pasteCards("p1", { worldX: 600, worldY: 0 });
    expect(newIds.length).toBe(1);
    const newId = newIds[0]!;

    // 副本有且仅有一条来自 up 的上游输入连线
    const into = useConnectionStore
      .getState()
      .getConnectionsByProject("p1")
      .filter((c) => c.targetCardId === newId);
    expect(into.length).toBe(1);
    expect(into[0]!.sourceCardId).toBe("up");
    // 原连线不受影响
    expect(useConnectionStore.getState().hasConnection("up", "a")).toBe(true);
  });

  it("出方向连线不复制 —— 下游邻居不会被副本多连一路", async () => {
    useCardStore.getState().addCard(makeCard("a", 0, 0));
    useCardStore.getState().addCard(makeCard("down", 300, 0));
    connect("c-a-down", "a", "down");

    await copyCards(new Set(["a"]));
    const newIds = await pasteCards("p1", { worldX: 600, worldY: 0 });
    const newId = newIds[0]!;

    // 副本不产生指向 down 的出方向连线
    expect(useConnectionStore.getState().hasConnection(newId, "down")).toBe(false);
    // down 仍只有来自原 a 的一路输入
    const intoDown = useConnectionStore
      .getState()
      .getConnectionsByProject("p1")
      .filter((c) => c.targetCardId === "down");
    expect(intoDown.length).toBe(1);
    expect(intoDown[0]!.sourceCardId).toBe("a");
  });

  it("上游邻居在目标项目不存在(跨项目粘贴)→ 跳过该入边,不报错", async () => {
    useCardStore.getState().addCard(makeCard("up", 0, 0));
    useCardStore.getState().addCard(makeCard("a", 300, 0));
    connect("c-up-a", "up", "a");

    await copyCards(new Set(["a"]));
    // 粘贴到另一个项目:up 不在 p2 → 入边应被跳过
    const newIds = await pasteCards("p2", { worldX: 0, worldY: 0 });
    expect(newIds.length).toBe(1);
    const newId = newIds[0]!;
    const into = useConnectionStore
      .getState()
      .getConnectionsByProject("p2")
      .filter((c) => c.targetCardId === newId);
    expect(into.length).toBe(0);
  });

  it("多选复制:内部连线两端重映射 + 各自的上游输入连线一并继承", async () => {
    // up → a → b,选中 {a, b} 复制
    useCardStore.getState().addCard(makeCard("up", 0, 0));
    useCardStore.getState().addCard(makeCard("a", 300, 0));
    useCardStore.getState().addCard(makeCard("b", 600, 0));
    connect("c-up-a", "up", "a");
    connect("c-a-b", "a", "b");

    await copyCards(new Set(["a", "b"]));
    const newIds = await pasteCards("p1", { worldX: 900, worldY: 0 });
    expect(newIds.length).toBe(2);
    const newSet = new Set(newIds);

    const conns = useConnectionStore.getState().getConnectionsByProject("p1");
    // a' = 收到来自 up 的入边的新卡
    const aPrimeEdge = conns.find(
      (c) => c.sourceCardId === "up" && newSet.has(c.targetCardId),
    );
    expect(aPrimeEdge).toBeDefined();
    const aPrime = aPrimeEdge!.targetCardId;
    // 内部连线 a→b 被重映射为 a'→b'(两端都是新卡)
    const internal = conns.find(
      (c) => c.sourceCardId === aPrime && newSet.has(c.targetCardId),
    );
    expect(internal).toBeDefined();
    expect(internal!.targetCardId).not.toBe(aPrime);
    // 原图保持不变:up→a、a→b 仍在
    expect(useConnectionStore.getState().hasConnection("up", "a")).toBe(true);
    expect(useConnectionStore.getState().hasConnection("a", "b")).toBe(true);
  });
});

describe("剪切移动保留全部连线(all)", () => {
  function connect(id: string, source: string, target: string) {
    useConnectionStore.getState().addConnection({
      id,
      projectId: "p1",
      sourceCardId: source,
      targetCardId: target,
      createdAt: "t0",
    });
  }

  const refsOf = (id: string) =>
    ((useCardStore.getState().getCard(id)!.data as Record<string, unknown>)
      .refImages as Record<string, { sourceCardId?: string }> | undefined) ?? {};

  it("移动单卡 → 上游输入连线跟随到新卡", async () => {
    useCardStore.getState().addCard(makeCard("up", 0, 0));
    useCardStore.getState().addCard(makeCard("a", 300, 0));
    connect("c-up-a", "up", "a");

    await cutCards(new Set(["a"]));
    const newIds = await pasteCards("p1", { worldX: 600, worldY: 0 });
    const newId = newIds[0]!;

    expect(useCardStore.getState().getCard("a")).toBeUndefined(); // 原卡移走
    expect(useConnectionStore.getState().hasConnection("up", newId)).toBe(true);
    expect(useConnectionStore.getState().hasConnection("up", "a")).toBe(false);
    expect(useCardStore.getState().getCardsByProject("p1").length).toBe(2); // up + 新卡
  });

  it("移动单卡 → 下游输出连线跟随到新卡", async () => {
    useCardStore.getState().addCard(makeCard("a", 0, 0));
    useCardStore.getState().addCard(makeCard("down", 300, 0));
    connect("c-a-down", "a", "down");

    await cutCards(new Set(["a"]));
    const newIds = await pasteCards("p1", { worldX: 600, worldY: 0 });
    const newId = newIds[0]!;

    expect(useConnectionStore.getState().hasConnection(newId, "down")).toBe(true);
    expect(useConnectionStore.getState().hasConnection("a", "down")).toBe(false);
  });

  it("移动带下游的卡 → 下游引用数据改挂到新卡(数据跟随移动,不丢)", async () => {
    useCardStore.getState().addCard(makeCard("a", 0, 0));
    useCardStore.getState().addCard(makeCard("down", 300, 0));
    connect("c-a-down", "a", "down");

    // 前置:a→down 已把 a 的图注入 down(确认注入管线在测试环境生效)
    expect(Object.values(refsOf("down")).some((r) => r.sourceCardId === "a")).toBe(true);

    await cutCards(new Set(["a"]));
    const newIds = await pasteCards("p1", { worldX: 600, worldY: 0 });
    const newId = newIds[0]!;

    // down 的参考图现在挂在新卡上,原卡 id 的残留被清掉 —— 数据完整跟随移动
    const downRefs = refsOf("down");
    expect(Object.values(downRefs).some((r) => r.sourceCardId === newId)).toBe(true);
    expect(Object.values(downRefs).some((r) => r.sourceCardId === "a")).toBe(false);
  });

  it("移动后撤销 → 原卡及其连线单步复原,新卡连线移除", async () => {
    useCardStore.getState().addCard(makeCard("up", 0, 0));
    useCardStore.getState().addCard(makeCard("a", 300, 0));
    connect("c-up-a", "up", "a");

    await cutCards(new Set(["a"]));
    const newIds = await pasteCards("p1", { worldX: 600, worldY: 0 });
    const newId = newIds[0]!;
    expect(useCardStore.getState().getCard("a")).toBeUndefined();

    history.undo();
    expect(useCardStore.getState().getCard("a")).toBeDefined();
    expect(useConnectionStore.getState().hasConnection("up", "a")).toBe(true);
    expect(useCardStore.getState().getCard(newId)).toBeUndefined();
    expect(useConnectionStore.getState().hasConnection("up", newId)).toBe(false);
  });

  it("跨项目移动 → 边界连线丢弃(邻居不在目标项目),卡片移过去", async () => {
    useCardStore.getState().addCard(makeCard("up", 0, 0));
    useCardStore.getState().addCard(makeCard("a", 300, 0));
    connect("c-up-a", "up", "a");

    await cutCards(new Set(["a"]));
    const newIds = await pasteCards("p2", { worldX: 0, worldY: 0 });
    const newId = newIds[0]!;

    expect(useCardStore.getState().getCard(newId)!.projectId).toBe("p2");
    expect(useConnectionStore.getState().hasConnection("up", newId)).toBe(false);
    expect(useCardStore.getState().getCard("a")).toBeUndefined(); // 原卡移走
  });
});
