import { describe, it, expect, beforeEach, vi } from "vitest";

// 量真实图比例的纯换算被 mock:返回一个 3:4 的卡尺寸(255×340),代表「结果图是竖图」。
// 不 mock 会走 new Image()/onload,jsdom 下永不触发 → 测试卡死。
vi.mock("@/lib/imageSize", () => ({
  imageCardSizeFromUrl: vi.fn(async () => ({ width: 255, height: 340 })),
}));
vi.mock("@/lib/media", () => ({
  getDisplayUrl: (s: string) => s,
}));
const markDirty = vi.fn();
vi.mock("@/lib/autoSave", () => ({
  autoSave: { markDirty: (...a: unknown[]) => markDirty(...a) },
}));

import { normalizeImageCardGeometry, isImageResultCardType } from "@/services/imageCardGeometry";
import { imageCardSizeFromUrl } from "@/lib/imageSize";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard, CardType } from "@/types";

function makeCard(type: CardType, width: number, height: number): CanvasCard {
  return {
    id: "c1",
    projectId: "p1",
    type,
    x: 0,
    y: 0,
    width,
    height,
    zIndex: 1,
    locked: false,
    collapsed: false,
    data: {},
    createdAt: "t",
    updatedAt: "t",
  };
}

describe("normalizeImageCardGeometry — 图片落卡几何归一(单一真相)", () => {
  beforeEach(() => {
    useCardStore.getState().clear();
    markDirty.mockClear();
    vi.mocked(imageCardSizeFromUrl).mockClear();
  });

  it("3:4 竖图落到 360×300 的方框 ai_image 卡 → 卡几何变 255×340(根治「显示成方形」)", async () => {
    useCardStore.getState().setCards([makeCard("ai_image", 360, 300)]);
    await normalizeImageCardGeometry("c1", "http://x/result.jpg");
    const card = useCardStore.getState().getCard("c1")!;
    expect(card.width).toBe(255);
    expect(card.height).toBe(340);
    expect(markDirty).toHaveBeenCalledWith("c1");
  });

  it("幂等:卡几何已等于结果比例 → 不再写、不 markDirty", async () => {
    useCardStore.getState().setCards([makeCard("ai_image", 255, 340)]);
    await normalizeImageCardGeometry("c1", "http://x/result.jpg");
    expect(markDirty).not.toHaveBeenCalled();
  });

  it("非图片产物卡(ai_chat)→ 跳过,不量图不改几何", async () => {
    useCardStore.getState().setCards([makeCard("ai_chat", 360, 300)]);
    await normalizeImageCardGeometry("c1", "http://x/result.jpg");
    expect(imageCardSizeFromUrl).not.toHaveBeenCalled();
    expect(markDirty).not.toHaveBeenCalled();
  });

  it("ai_tryon / ai_multiangle 也归一(换装/多角度同享统一收口)", async () => {
    expect(isImageResultCardType("ai_tryon")).toBe(true);
    expect(isImageResultCardType("ai_multiangle")).toBe(true);
    expect(isImageResultCardType("ai_video")).toBe(false);
    useCardStore.getState().setCards([makeCard("ai_tryon", 300, 400)]);
    await normalizeImageCardGeometry("c1", "http://x/r.jpg");
    expect(useCardStore.getState().getCard("c1")!.width).toBe(255);
  });

  it("卡不存在 / 空 url → 不抛错、无副作用", async () => {
    await expect(normalizeImageCardGeometry("missing", "http://x/r.jpg")).resolves.toBeUndefined();
    await expect(normalizeImageCardGeometry("c1", "")).resolves.toBeUndefined();
    expect(markDirty).not.toHaveBeenCalled();
  });
});
