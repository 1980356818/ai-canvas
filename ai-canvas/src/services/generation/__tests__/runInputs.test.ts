/**
 * 输入指纹防漂移测试(断点续跑的硬保障)。
 *   - 敏感性:改「会改变生成结果」的输入字段 → fp 必变。
 *   - 不敏感性:改几何/title/_showLabel/selectedIndex/产物字段 → fp 不变。
 *   - 归一:空 vs 显式缺省同 fp(tryon 空 content、chat 空 _systemPrompt、video tier 缺省)。
 *   - 键序无关:upstreamTexts / refImages 键序打乱 → fp 不变。
 */

import { describe, it, expect } from "vitest";
import type { CanvasCard, CardType } from "@/types";
import { runInputFingerprint, collectRunInputs } from "@/services/generation/runInputs";
import { CHAT_EDITOR_DEFAULT_SYSTEM_PROMPT } from "@/lib/systemPrompts";

const TRYON_DEFAULT = "将服装穿在人物身上，保持人物姿态和背景不变";

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
const fp = (type: CardType, data: Record<string, unknown>) =>
  runInputFingerprint(makeCard(type, data));

describe("指纹敏感性 — 改输入 fp 必变", () => {
  const base = { model: "gpt-image-2", content: "a cat" };
  it("ai_image: content / model / size / quality 改动各自改 fp", () => {
    const b = fp("ai_image", base);
    expect(fp("ai_image", { ...base, content: "a dog" })).not.toBe(b);
    expect(fp("ai_image", { ...base, model: "nano-banana" })).not.toBe(b);
    // size 用宽高比(原样透传,不被 legacy 兜底归一到同一默认)验灵敏度
    expect(fp("ai_image", { ...base, size: "16:9" })).not.toBe(
      fp("ai_image", { ...base, size: "9:16" }),
    );
    expect(fp("ai_image", { ...base, quality: "high" })).not.toBe(b);
  });

  it("ai_chat: prompt / refImages url / directMedia / refVideos 改动各自改 fp", () => {
    const cb = { model: "gemini-3.1-pro-preview", content: "hi" };
    const b = fp("ai_chat", cb);
    expect(fp("ai_chat", { ...cb, content: "yo" })).not.toBe(b);
    expect(
      fp("ai_chat", { ...cb, refImages: { a: { url: "u1" } } }),
    ).not.toBe(b);
    expect(
      fp("ai_chat", { ...cb, refImages: { a: { url: "u2" } } }),
    ).not.toBe(fp("ai_chat", { ...cb, refImages: { a: { url: "u1" } } }));
    expect(
      fp("ai_chat", { ...cb, directMedia: [{ url: "v", kind: "video" }] }),
    ).not.toBe(b);
  });

  it("ai_video: 改 seedanceTier / duration / generateAudio 各自改 fp", () => {
    const vb = { model: "seedance", content: "run" };
    const b = fp("ai_video", vb);
    expect(fp("ai_video", { ...vb, seedanceTier: "fast" })).not.toBe(b);
    expect(fp("ai_video", { ...vb, duration: 8 })).not.toBe(b);
    expect(fp("ai_video", { ...vb, generateAudio: false })).not.toBe(b);
  });
});

describe("指纹不敏感性 — 改非输入 fp 不变", () => {
  it("几何 / title / _showLabel / selectedIndex / 产物字段都不进指纹", () => {
    const data = { model: "gpt-image-2", content: "a cat" };
    const b = fp("ai_image", data);
    // 几何在卡顶层,不在 data;collectInputs 只读 data,故天然不含。这里验产物/标记字段:
    expect(fp("ai_image", { ...data, _showLabel: true })).toBe(b);
    expect(fp("ai_image", { ...data, selectedIndex: 3 })).toBe(b);
    expect(fp("ai_image", { ...data, imageUrl: "http://x/y.png" })).toBe(b);
    expect(fp("ai_image", { ...data, results: [{ url: "a" }, { url: "b" }] })).toBe(b);
    expect(fp("ai_image", { ...data, result: "stale text" })).toBe(b);
  });

  it("顶层几何/title 改动不影响 fp(collectInputs 只读 card.data)", () => {
    const data = { model: "gpt-image-2", content: "a cat" };
    const a = makeCard("ai_image", data);
    const moved = { ...a, x: 999, y: 888, width: 10, height: 10, zIndex: 50, title: "改了" };
    expect(runInputFingerprint(moved)).toBe(runInputFingerprint(a));
  });
});

describe("指纹归一 — 空与显式缺省同 fp", () => {
  it("ai_tryon: 空 content 与默认指令同 fp", () => {
    const tb = { model: "gpt-image-2", personImageUrl: "p", garmentImageUrl: "g" };
    expect(fp("ai_tryon", { ...tb, content: "" })).toBe(
      fp("ai_tryon", { ...tb, content: TRYON_DEFAULT }),
    );
    expect(fp("ai_tryon", { ...tb, content: "   " })).toBe(
      fp("ai_tryon", { ...tb, content: TRYON_DEFAULT }),
    );
  });

  it("ai_chat: 空 _systemPrompt 与默认 system prompt 同 fp", () => {
    const cb = { model: "gemini-3.1-pro-preview", content: "hi" };
    expect(fp("ai_chat", cb)).toBe(
      fp("ai_chat", { ...cb, _systemPrompt: CHAT_EDITOR_DEFAULT_SYSTEM_PROMPT }),
    );
  });

  it("ai_video: tier/duration/generateAudio 未设置与显式缺省同 fp", () => {
    const vb = { model: "seedance", content: "run" };
    expect(fp("ai_video", vb)).toBe(
      fp("ai_video", {
        ...vb,
        seedanceTier: "standard",
        duration: 5,
        generateAudio: true,
      }),
    );
  });
});

describe("指纹键序无关", () => {
  it("ai_chat: upstreamTexts 键序打乱 → fp 不变", () => {
    const cb = { model: "gemini-3.1-pro-preview", content: "hi" };
    const a = fp("ai_chat", { ...cb, upstreamTexts: { x: "1", y: "2" } });
    const b = fp("ai_chat", { ...cb, upstreamTexts: { y: "2", x: "1" } });
    expect(a).toBe(b);
  });

  it("ai_chat: upstreamTexts 值改了 → fp 必变", () => {
    const cb = { model: "gemini-3.1-pro-preview", content: "hi" };
    const a = fp("ai_chat", { ...cb, upstreamTexts: { x: "1" } });
    const b = fp("ai_chat", { ...cb, upstreamTexts: { x: "2" } });
    expect(a).not.toBe(b);
  });
});

describe("无运行语义类型", () => {
  it("text/sticky_note/audio → collectRunInputs 返回 null,fp 稳定且与 data 无关", () => {
    expect(collectRunInputs(makeCard("text", { content: "abc" }))).toBeNull();
    expect(fp("text", { content: "abc" })).toBe(fp("text", { content: "xyz" }));
  });
});
