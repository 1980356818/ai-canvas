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
