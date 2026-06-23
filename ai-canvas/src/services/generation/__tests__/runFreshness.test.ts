/**
 * 新鲜度判定测试(§8.2)。isCardFresh 对传入的 card 纯函数判定,无需 store。
 */

import { describe, it, expect } from "vitest";
import type { CanvasCard, CardType } from "@/types";
import { isCardFresh } from "@/services/generation/runFreshness";
import { runInputFingerprint } from "@/services/generation/runInputs";

function makeCard(type: CardType, data: Record<string, unknown>): CanvasCard {
  return {
    id: "c1",
    projectId: "p1",
    type,
    x: 0,
    y: 0,
    width: 360,
    height: 300,
    zIndex: 1,
    locked: false,
    collapsed: false,
    title: undefined,
    data,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  } as CanvasCard;
}

/** 给一张卡盖上「与当前输入匹配、已确认」的真戳。 */
function withConfirmedStamp(card: CanvasCard): CanvasCard {
  const fp = runInputFingerprint(card);
  return makeCard(card.type, {
    ...(card.data as Record<string, unknown>),
    _run: { fp, at: "2026-01-01T00:00:00Z", pending: false },
  });
}

describe("isCardFresh", () => {
  it("模板演示卡(有 imageUrl 但无 _run 戳)→ 不新鲜(必重跑)", () => {
    const card = makeCard("ai_image", {
      model: "gpt-image-2",
      content: "demo",
      imageUrl: "http://x/demo.png",
      _showLabel: true,
    });
    expect(isCardFresh(card)).toBe(false);
  });

  it("真生成卡(戳已确认、fp 匹配)→ 新鲜(跳过)", () => {
    const card = makeCard("ai_image", { model: "gpt-image-2", content: "a cat" });
    expect(isCardFresh(withConfirmedStamp(card))).toBe(true);
  });

  it("真生成后改 prompt → fp 不匹配 → 不新鲜(重跑)", () => {
    const card = makeCard("ai_image", { model: "gpt-image-2", content: "a cat" });
    const stamped = withConfirmedStamp(card);
    // 改 content,但保留旧戳 → fp 不再匹配
    const edited = makeCard("ai_image", {
      ...(stamped.data as Record<string, unknown>),
      content: "a dog",
    });
    expect(isCardFresh(edited)).toBe(false);
  });

  it("pending 戳(在途 / 崩溃残留)→ 不新鲜", () => {
    const card = makeCard("ai_image", { model: "gpt-image-2", content: "a cat" });
    const fp = runInputFingerprint(card);
    const pendingCard = makeCard("ai_image", {
      ...(card.data as Record<string, unknown>),
      _run: { fp, at: "2026-01-01T00:00:00Z", pending: true },
    });
    expect(isCardFresh(pendingCard)).toBe(false);
  });

  it("text / sticky_note / audio → 永远新鲜(无运行语义,跳过)", () => {
    expect(isCardFresh(makeCard("text", { content: "x" }))).toBe(true);
    expect(isCardFresh(makeCard("sticky_note", { content: "x" }))).toBe(true);
    expect(isCardFresh(makeCard("audio", {}))).toBe(true);
  });

  it("frame_extractor → P0–P2 暂按非新鲜(每次都跑,不漏)", () => {
    expect(isCardFresh(makeCard("frame_extractor", {}))).toBe(false);
  });
});
