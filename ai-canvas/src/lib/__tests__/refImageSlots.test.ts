import { describe, it, expect } from "vitest";
import {
  listRefEntries,
  listRefSlots,
  normalize,
  clampTo,
  reorder,
  removeAt,
  removeSources,
  setAt,
  upsertBySource,
  isPositional,
  type RefImages,
} from "@/lib/refImageSlots";
import { applySlotKeyMap } from "@/lib/promptSerializer";
import { getRefSlotsForModel, type RefImageEntry, type RefImageSlot } from "@/config/model-ref-images";

const SLOTS = getRefSlotsForModel("nano-banana"); // refImage0..13, positional
const NAMED: RefImageSlot[] = [
  { key: "person", label: "人物", description: "", required: false },
  { key: "garment", label: "服装", description: "", required: false },
];

function card(id: string): RefImageEntry {
  return { url: `u_${id}`, sourceCardId: id, sourceType: "card" };
}
function file(url: string): RefImageEntry {
  return { url, sourceType: "file" };
}
function sources(refImages: RefImages | undefined): string[] {
  return listRefEntries(refImages, SLOTS).map((e) => e.sourceCardId ?? `file:${e.url}`);
}
function keys(refImages: RefImages | undefined): string[] {
  return listRefSlots(refImages, SLOTS).map((x) => x.slotKey);
}

describe("refImageSlots — 读序", () => {
  it("listRefEntries 按槽顺序,跳过空洞", () => {
    const ri: RefImages = { refImage0: card("A"), refImage2: card("C") };
    expect(sources(ri)).toEqual(["A", "C"]);
    expect(keys(ri)).toEqual(["refImage0", "refImage2"]);
  });
});

describe("refImageSlots — normalize 紧凑连续", () => {
  it("压掉空洞并产出 keyMap", () => {
    const ri: RefImages = { refImage0: card("A"), refImage2: card("C"), refImage5: card("E") };
    const m = normalize(ri, SLOTS);
    expect(sources(m.refImages)).toEqual(["A", "C", "E"]);
    expect(keys(m.refImages)).toEqual(["refImage0", "refImage1", "refImage2"]);
    expect(m.keyMap.get("refImage2")).toBe("refImage1");
    expect(m.keyMap.get("refImage5")).toBe("refImage2");
    expect(m.changed).toBe(true);
  });
  it("已规范 → 不变", () => {
    const ri: RefImages = { refImage0: card("A"), refImage1: card("B") };
    expect(normalize(ri, SLOTS).changed).toBe(false);
  });
});

describe("refImageSlots — reorder", () => {
  it("把队尾拖到队首,产出 keyMap", () => {
    const ri: RefImages = { refImage0: card("A"), refImage1: card("B"), refImage2: card("C") };
    const m = reorder(ri, SLOTS, "refImage2", "refImage0");
    expect(sources(m.refImages)).toEqual(["C", "A", "B"]);
    expect(keys(m.refImages)).toEqual(["refImage0", "refImage1", "refImage2"]);
  });
});

describe("refImageSlots — 删除", () => {
  it("removeAt 删中间并 compact", () => {
    const ri: RefImages = { refImage0: card("A"), refImage1: card("B"), refImage2: card("C") };
    const m = removeAt(ri, SLOTS, "refImage1");
    expect(sources(m.refImages)).toEqual(["A", "C"]);
    expect(keys(m.refImages)).toEqual(["refImage0", "refImage1"]); // C 上移,无空洞
    expect(m.removed).toEqual(["refImage1"]);
    expect(m.keyMap.get("refImage2")).toBe("refImage1");
  });
  it("removeSources 删指定源并 compact", () => {
    const ri: RefImages = { refImage0: card("A"), refImage1: card("B"), refImage2: card("C") };
    const m = removeSources(ri, SLOTS, ["B"]);
    expect(sources(m.refImages)).toEqual(["A", "C"]);
    expect(keys(m.refImages)).toEqual(["refImage0", "refImage1"]);
  });
  it("removeAt 删到空 → undefined", () => {
    const ri: RefImages = { refImage0: card("A") };
    expect(removeAt(ri, SLOTS, "refImage0").refImages).toBeUndefined();
  });
});

describe("refImageSlots — setAt 原位替换", () => {
  it("替换占用槽,位置不变", () => {
    const ri: RefImages = { refImage0: card("A"), refImage1: card("B") };
    const m = setAt(ri, SLOTS, "refImage0", file("newfile"));
    expect(sources(m.refImages)).toEqual(["file:newfile", "B"]); // 仍在 refImage0
    expect(m.keyMap.size).toBe(0);
  });
});

describe("refImageSlots — upsertBySource(连线注入口径)", () => {
  it("同源 → 原位更新 url(位置不变)", () => {
    const ri: RefImages = { refImage0: card("C"), refImage1: card("A"), refImage2: card("B") };
    const m = upsertBySource(ri, SLOTS, "A", "u_A_NEW");
    expect(sources(m.refImages)).toEqual(["C", "A", "B"]); // A 仍在中间
    expect(m.refImages!.refImage1!.url).toBe("u_A_NEW");
  });
  it("新源 → 追加到队尾", () => {
    const ri: RefImages = { refImage0: card("A"), refImage1: card("B") };
    const m = upsertBySource(ri, SLOTS, "D", "u_D");
    expect(sources(m.refImages)).toEqual(["A", "B", "D"]);
  });
  it("同源同 url → 不变", () => {
    const ri: RefImages = { refImage0: card("A") };
    expect(upsertBySource(ri, SLOTS, "A", "u_A").changed).toBe(false);
  });
});

describe("refImageSlots — clampTo", () => {
  it("超出上限丢队尾", () => {
    const ri: RefImages = { refImage0: card("A"), refImage1: card("B"), refImage2: card("C") };
    const m = clampTo(ri, SLOTS, 2);
    expect(sources(m.refImages)).toEqual(["A", "B"]);
    expect(m.removed).toEqual(["refImage2"]);
  });
});

describe("refImageSlots — 具名槽(试衣)不 compact", () => {
  it("isPositional 区分", () => {
    expect(isPositional(SLOTS)).toBe(true);
    expect(isPositional(NAMED)).toBe(false);
  });
  it("removeSources 删 person 不动 garment 的 key", () => {
    const ri: RefImages = { person: card("P"), garment: card("G") };
    const m = removeSources(ri, NAMED, ["P"]);
    expect(m.refImages).toEqual({ garment: card("G") }); // garment 原 key 不变,无 compact
    expect(m.keyMap.size).toBe(0);
  });
});

describe("applySlotKeyMap — 提示词内联引用对齐", () => {
  const mk = (slotKey: string) => ({
    id: `slot:${slotKey}`,
    displayLabel: `图${parseInt(slotKey.replace("refImage", ""), 10) + 1}`,
    source: { type: "refSlot" as const, slotKey },
  });

  it("重命名(含互换)token 与引用", () => {
    const content = "看 {{ref:slot:refImage0}} 和 {{ref:slot:refImage1}}";
    const refs = [mk("refImage0"), mk("refImage1")];
    const keyMap = new Map([["refImage0", "refImage1"], ["refImage1", "refImage0"]]);
    const out = applySlotKeyMap(content, refs, keyMap, []);
    expect(out.content).toBe("看 {{ref:slot:refImage1}} 和 {{ref:slot:refImage0}}");
    const byKey = Object.fromEntries(out.inlineRefs.map((r) => [(r.source as { slotKey: string }).slotKey, r.displayLabel]));
    expect(byKey).toEqual({ refImage1: "图2", refImage0: "图1" });
  });

  it("删除槽 → 丢 token 与引用,其余按 keyMap 上移", () => {
    const content = "A{{ref:slot:refImage0}} B{{ref:slot:refImage1}} C{{ref:slot:refImage2}}";
    const refs = [mk("refImage0"), mk("refImage1"), mk("refImage2")];
    // 删 refImage1,refImage2→refImage1
    const out = applySlotKeyMap(content, refs, new Map([["refImage2", "refImage1"]]), ["refImage1"]);
    expect(out.content).toContain("{{ref:slot:refImage0}}");
    expect(out.content).not.toContain("__SLOTMAP_");
    expect(out.inlineRefs.map((r) => (r.source as { slotKey: string }).slotKey)).toEqual(["refImage0", "refImage1"]);
  });
});
