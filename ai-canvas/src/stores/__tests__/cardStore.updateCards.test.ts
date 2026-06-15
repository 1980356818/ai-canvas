import { describe, it, expect, beforeEach } from "vitest";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard } from "@/types";

function makeCard(id: string, over: Partial<CanvasCard> = {}): CanvasCard {
  return {
    id,
    projectId: "p1",
    type: "ai_image",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    zIndex: 1,
    locked: false,
    collapsed: false,
    data: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  useCardStore.getState().setCards([]);
});

describe("cardStore.updateCards (批量提交 — 多选/整组拖拽落点)", () => {
  it("移动 N 张卡,layoutVersion 只 +1(空间索引单次 diff 的前提)", () => {
    useCardStore.getState().setCards([makeCard("a"), makeCard("b"), makeCard("c")]);
    const lv0 = useCardStore.getState().layoutVersion;
    const dv0 = useCardStore.getState().dataVersion;

    useCardStore.getState().updateCards([
      { id: "a", partial: { x: 50, y: 60 } },
      { id: "b", partial: { x: 70, y: 80 } },
    ]);

    const st = useCardStore.getState();
    expect(st.cards.get("a")).toMatchObject({ x: 50, y: 60 });
    expect(st.cards.get("b")).toMatchObject({ x: 70, y: 80 });
    expect(st.cards.get("c")).toMatchObject({ x: 0, y: 0 }); // 未涉及的卡不动
    expect(st.layoutVersion).toBe(lv0 + 1); // 恰好一次 bump
    expect(st.dataVersion).toBe(dv0); // 纯几何 → 不动 dataVersion
  });

  it("空数组是 no-op(不 bump 任何版本)", () => {
    useCardStore.getState().setCards([makeCard("a")]);
    const { layoutVersion: lv, dataVersion: dv } = useCardStore.getState();
    useCardStore.getState().updateCards([]);
    const st = useCardStore.getState();
    expect(st.layoutVersion).toBe(lv);
    expect(st.dataVersion).toBe(dv);
  });

  it("跳过不存在的 id,应用存在的 id", () => {
    useCardStore.getState().setCards([makeCard("a")]);
    const lv = useCardStore.getState().layoutVersion;
    useCardStore.getState().updateCards([
      { id: "missing", partial: { x: 999 } },
      { id: "a", partial: { x: 5 } },
    ]);
    const st = useCardStore.getState();
    expect(st.cards.get("a")).toMatchObject({ x: 5 });
    expect(st.cards.has("missing")).toBe(false);
    expect(st.layoutVersion).toBe(lv + 1);
  });

  it("坐标未变 → 不 bump layoutVersion", () => {
    useCardStore.getState().setCards([makeCard("a", { x: 10, y: 10 })]);
    const lv = useCardStore.getState().layoutVersion;
    useCardStore.getState().updateCards([{ id: "a", partial: { x: 10, y: 10 } }]);
    expect(useCardStore.getState().layoutVersion).toBe(lv);
  });

  it("data 改动 → dataVersion +1 且只记录被改的 id", () => {
    useCardStore.getState().setCards([makeCard("a"), makeCard("b")]);
    const dv = useCardStore.getState().dataVersion;
    useCardStore.getState().updateCards([
      { id: "a", partial: { data: { foo: 1 } } },
      { id: "b", partial: { x: 5 } },
    ]);
    const st = useCardStore.getState();
    expect(st.dataVersion).toBe(dv + 1);
    expect([...st.lastMutatedDataIds]).toEqual(["a"]);
  });
});
