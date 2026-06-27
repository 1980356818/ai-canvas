/**
 * 集成回归:验证统一后的参考图「顺序 + 提示词内联 @ 引用」在编辑器变更与连线断开两条路径上始终同步。
 * 走真实 store / editRefImages / referenceConsistency 生命周期钩子。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useCardStore } from "@/stores/cardStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { autoSave } from "@/lib/autoSave";
import { editRefImages, reorder } from "@/lib/refImageSlots";
import { disconnectCardPairAndCleanup } from "@/lib/referenceConsistency";
import "@/lib/referenceConsistency"; // 注册连线生命周期钩子
import { getRefSlotsForModel, type RefImageEntry } from "@/config/model-ref-images";
import type { InlineImageRef } from "@/lib/promptSerializer";
import type { CanvasCard, Connection } from "@/types";

const SLOTS = getRefSlotsForModel("nano-banana");

function imgCard(id: string, data: Record<string, unknown> = {}): CanvasCard {
  return {
    id, projectId: "p", type: "ai_image",
    x: 0, y: 0, width: 1, height: 1, zIndex: 1,
    locked: false, collapsed: false, title: id,
    data, createdAt: "t", updatedAt: "t",
  } as CanvasCard;
}
function conn(s: string, t: string): Connection {
  return { id: `${s}->${t}`, projectId: "p", sourceCardId: s, targetCardId: t, createdAt: "t" } as Connection;
}
function inlineRef(slotKey: string): InlineImageRef {
  const idx = parseInt(slotKey.replace("refImage", ""), 10);
  return { id: `slot:${slotKey}`, displayLabel: `图${idx + 1}`, source: { type: "refSlot", slotKey } };
}
function T() {
  return useCardStore.getState().getCard("T")!.data as {
    refImages?: Record<string, RefImageEntry>;
    content?: string;
    inlineRefs?: InlineImageRef[];
  };
}
function order(): string[] {
  const ri = T().refImages;
  return SLOTS.map((s) => ri?.[s.key]).filter((e): e is RefImageEntry => !!e).map((e) => e.sourceCardId ?? "?");
}

beforeEach(() => {
  useCardStore.getState().setCards([]);
  useConnectionStore.getState().setConnections([]);
});
afterEach(() => autoSave.destroy());

function setup(content: string, inlineRefs: InlineImageRef[]) {
  useCardStore.getState().setCards([
    imgCard("A", { imageUrl: "uA", results: [{ url: "uA" }] }),
    imgCard("B", { imageUrl: "uB", results: [{ url: "uB" }] }),
    imgCard("C", { imageUrl: "uC", results: [{ url: "uC" }] }),
    imgCard("T", { model: "nano-banana", content, inlineRefs,
      refImages: {
        refImage0: { url: "uA", sourceCardId: "A", sourceType: "card" },
        refImage1: { url: "uB", sourceCardId: "B", sourceType: "card" },
        refImage2: { url: "uC", sourceCardId: "C", sourceType: "card" },
      } }),
  ]);
  useConnectionStore.getState().setConnections([conn("A", "T"), conn("B", "T"), conn("C", "T")]);
}

describe("统一:编辑器重排同时对齐提示词内联引用", () => {
  it("把 C 拖到队首,refImages 与 content/inlineRefs 的槽 token 一并更新", () => {
    // 引用 A(refImage0) 和 C(refImage2)
    setup("x {{ref:slot:refImage0}} y {{ref:slot:refImage2}}", [inlineRef("refImage0"), inlineRef("refImage2")]);

    editRefImages("T", SLOTS, (ri, slots) => reorder(ri, slots, "refImage2", "refImage0"));

    expect(order()).toEqual(["C", "A", "B"]);
    // A: refImage0→refImage1, C: refImage2→refImage0
    expect(T().content).toBe("x {{ref:slot:refImage1}} y {{ref:slot:refImage0}}");
    const byKey = Object.fromEntries(T().inlineRefs!.map((r) => [(r.source as { slotKey: string }).slotKey, r.displayLabel]));
    expect(byKey).toEqual({ refImage1: "图2", refImage0: "图1" });
  });
});

describe("统一:断开连线后 compact 并对齐提示词内联引用", () => {
  it("断开队首 A → B/C 上移、content token 与引用同步重映射", () => {
    // 引用 B(refImage1)
    setup("draw {{ref:slot:refImage1}}", [inlineRef("refImage1")]);

    disconnectCardPairAndCleanup("A", "T");

    expect(order()).toEqual(["B", "C"]); // A 删除,B/C compact 上移(无空洞)
    // B: refImage1→refImage0
    expect(T().content).toBe("draw {{ref:slot:refImage0}}");
    expect(T().inlineRefs).toHaveLength(1);
    expect((T().inlineRefs![0]!.source as { slotKey: string }).slotKey).toBe("refImage0");
    expect(T().inlineRefs![0]!.displayLabel).toBe("图1");
  });

  it("断开被引用的源 → 该内联引用与 token 一并删除", () => {
    setup("see {{ref:slot:refImage0}} end", [inlineRef("refImage0")]);

    disconnectCardPairAndCleanup("A", "T"); // A 在 refImage0,被引用

    expect(order()).toEqual(["B", "C"]);
    expect(T().content).not.toContain("refImage0"); // A 的 token 删除
    expect(T().content).not.toContain("__SLOTMAP_");
    // 剩余引用应为空(原内容只引用了被删的 A)
    expect(T().inlineRefs ?? []).toHaveLength(0);
  });
});
