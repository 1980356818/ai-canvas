/**
 * 回归:手动拖动的参考图顺序必须在「重新生成」后保持不变。
 *
 * Bug:整组「重新生成」(rerun) 先对每张卡 clearRunnableOutput 清产物 → 上游 output 暂态变 none
 * → dataFlow watcher 调 propagateFromCard(上游) 命中 none 分支 → 旧实现会 removeRefImageForSource
 * 把下游参考图删掉并 compact → 上游新产物落卡时 injectIntoCard 塞进**第一个空槽**(队尾),
 * 用户手动拖的顺序被冲掉。
 *
 * 修复:参考图是「连线」语义,output 暂态 none 时**不删**(只在连线真断时由 referenceConsistency
 * 删)。新产物到来时 injectIntoCard 凭 sourceCardId 原位更新,顺序与槽位都稳定。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useCardStore } from "@/stores/cardStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { autoSave } from "@/lib/autoSave";
import { propagateFromCard, startDataFlowWatcher } from "@/lib/dataFlow";
// 副作用 import:注册连线生命周期钩子(onConnectionsAdded -> injectOnConnections)
import "@/lib/referenceConsistency";
import { getRefSlotsForModel, type RefImageEntry } from "@/config/model-ref-images";
import type { CanvasCard, Connection } from "@/types";

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

/** 下游 T 的参考图按槽位顺序读出 sourceCardId 序列(= 用户看到的参考图顺序)。 */
function order(): string[] {
  const t = useCardStore.getState().getCard("T")!;
  const refImages = (t.data as Record<string, unknown>).refImages as Record<string, RefImageEntry>;
  return getRefSlotsForModel("nano-banana")
    .map((s) => refImages?.[s.key])
    .filter((e): e is RefImageEntry => !!e)
    .map((e) => e.sourceCardId ?? "?");
}

/** 复刻 MediaEditor.handleReorder:把 fromSlot 的条目移到 toSlot 的位置(槽 key 不变,只换内容)。 */
function reorder(fromSlotKey: string, toSlotKey: string) {
  const current = useCardStore.getState().getCard("T")!.data as { refImages?: Record<string, RefImageEntry> };
  const refSlots = getRefSlotsForModel("nano-banana");
  if (!current.refImages?.[fromSlotKey] || !current.refImages?.[toSlotKey] || fromSlotKey === toSlotKey) return;
  const occupiedKeys = refSlots.map((s) => s.key).filter((k) => current.refImages![k]);
  const fromIdx = occupiedKeys.indexOf(fromSlotKey);
  const toIdx = occupiedKeys.indexOf(toSlotKey);
  if (fromIdx === -1 || toIdx === -1) return;
  const entries = occupiedKeys.map((k) => current.refImages![k]!);
  const [moved] = entries.splice(fromIdx, 1);
  entries.splice(toIdx, 0, moved!);
  const refImages: Record<string, RefImageEntry> = {};
  entries.forEach((entry, i) => { refImages[occupiedKeys[i]!] = entry; });
  useCardStore.getState().updateCardData("T", { refImages });
}

function setupChain() {
  useCardStore.getState().setCards([
    imgCard("A", { imageUrl: "uA", results: [{ url: "uA" }] }),
    imgCard("B", { imageUrl: "uB", results: [{ url: "uB" }] }),
    imgCard("C", { imageUrl: "uC", results: [{ url: "uC" }] }),
    imgCard("T", { model: "nano-banana", content: "draw" }),
  ]);
  useConnectionStore.getState().addConnection(conn("A", "T"));
  useConnectionStore.getState().addConnection(conn("B", "T"));
  useConnectionStore.getState().addConnection(conn("C", "T"));
}

/** 模拟一张上游卡重跑:clearRunnableOutput 清产物(暂态 none)→ 重跑成功落新产物。 */
function rerunUpstream(id: string) {
  useCardStore.getState().updateCardData(id, { imageUrl: undefined, results: undefined, selectedIndex: undefined });
  propagateFromCard(id); // 暂态 none
  useCardStore.getState().updateCardData(id, { imageUrl: `${id}2`, results: [{ url: `${id}2` }], selectedIndex: 0 });
  propagateFromCard(id); // 新产物
}

beforeEach(() => {
  useCardStore.getState().setCards([]);
  useConnectionStore.getState().setConnections([]);
});
afterEach(() => autoSave.destroy());

describe("参考图顺序在「重新生成」后保持", () => {
  it("初始注入按连线顺序 A,B,C", () => {
    setupChain();
    expect(order()).toEqual(["A", "B", "C"]);
  });

  it("拖动重排后,上游单卡重跑不改变顺序", () => {
    setupChain();
    reorder("refImage2", "refImage0"); // C 拖到最前 -> C,A,B
    expect(order()).toEqual(["C", "A", "B"]);
    rerunUpstream("A");
    expect(order()).toEqual(["C", "A", "B"]);
  });

  it("拖动重排后,整组重新生成(所有上游清产物再重跑)不改变顺序", () => {
    setupChain();
    reorder("refImage2", "refImage0"); // -> C,A,B
    reorder("refImage2", "refImage1"); // B 移到 A 前 -> C,B,A
    expect(order()).toEqual(["C", "B", "A"]);

    // 整组 rerun:先全部清产物(暂态 none),再按连线顺序 A,B,C 依次重跑落产物。
    for (const id of ["A", "B", "C"]) {
      useCardStore.getState().updateCardData(id, { imageUrl: undefined, results: undefined, selectedIndex: undefined });
      propagateFromCard(id);
    }
    expect(order()).toEqual(["C", "B", "A"]); // 重跑期间旧图保留,槽位不动
    for (const id of ["A", "B", "C"]) {
      useCardStore.getState().updateCardData(id, { imageUrl: `${id}2`, results: [{ url: `${id}2` }], selectedIndex: 0 });
      propagateFromCard(id);
    }
    expect(order()).toEqual(["C", "B", "A"]); // 手动顺序贯穿整组重跑
  });

  it("替换上游图片内容(同一张源卡,新URL/换选中结果)-> 位置不变,只更新该槽内容", () => {
    setupChain();
    reorder("refImage2", "refImage0"); // -> C,A,B(A 在中间)
    // 上游 A 重新生成 / 在源卡上换图 → A 的产物 URL 变了,但仍是同一张源卡
    useCardStore.getState().updateCardData("A", { imageUrl: "uA_NEW", results: [{ url: "uA_NEW" }], selectedIndex: 0 });
    propagateFromCard("A");
    const t = useCardStore.getState().getCard("T")!;
    const ri = (t.data as Record<string, unknown>).refImages as Record<string, RefImageEntry>;
    expect(order()).toEqual(["C", "A", "B"]); // A 仍在中间(注入按 sourceCardId 原位更新)
    expect(ri.refImage1!.url).toBe("uA_NEW"); // 仅内容更新
  });

  it("拖动重排后,重新载入(startDataFlowWatcher 初始同步)不改变顺序", () => {
    setupChain();
    reorder("refImage2", "refImage0"); // -> C,A,B
    const cleanup = startDataFlowWatcher();
    expect(order()).toEqual(["C", "A", "B"]);
    cleanup();
  });
});
