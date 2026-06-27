/**
 * ai_script 的连线 I/O 与 ai_chat 同构(镜像)验证。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { extractOutput, canAcceptConnection } from "@/lib/dataFlow";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard, CardType } from "@/types";

let seq = 0;
function makeCard(type: CardType, data: Record<string, unknown>): CanvasCard {
  seq += 1;
  return {
    id: `card-${seq}`, projectId: "p1", type,
    x: 0, y: 0, width: 360, height: 300, zIndex: 1,
    locked: false, collapsed: false, data,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as CanvasCard;
}

beforeEach(() => useCardStore.getState().clear());

describe("extractOutput · ai_script 输出文本(同 ai_chat)", () => {
  it("有 result → text", () => {
    const text = "# 视频脚本\n## 逐秒镜头拆解";
    expect(extractOutput(makeCard("ai_script", { result: text }))).toEqual({ kind: "text", text });
    expect(extractOutput(makeCard("ai_chat", { result: text }))).toEqual({ kind: "text", text });
  });
  it("空 / 错误前缀 → none", () => {
    expect(extractOutput(makeCard("ai_script", {}))).toEqual({ kind: "none" });
    expect(extractOutput(makeCard("ai_script", { result: "错误: 失败" }))).toEqual({ kind: "none" });
  });
});

describe("canAcceptConnection · 图/视频/文本可连入 ai_script(同 ai_chat)", () => {
  it("文本节点可连入", () => {
    const txt = makeCard("text", { content: "补充信息" });
    const script = makeCard("ai_script", {});
    [txt, script].forEach((c) => useCardStore.getState().addCard(c));
    expect(canAcceptConnection(script.id, txt.id)).toBe(true);
  });

  it("图片节点可连入(占用参考图槽位)", () => {
    const img = makeCard("ai_image", { imageUrl: "http://x/a.png" });
    const script = makeCard("ai_script", {});
    [img, script].forEach((c) => useCardStore.getState().addCard(c));
    expect(canAcceptConnection(script.id, img.id)).toBe(true);
  });

  it("视频节点可连入(refVideos ≤ 3)", () => {
    const vid = makeCard("ai_video", { videoUrl: "http://x/a.mp4" });
    const script = makeCard("ai_script", {});
    [vid, script].forEach((c) => useCardStore.getState().addCard(c));
    expect(canAcceptConnection(script.id, vid.id)).toBe(true);
  });

  it("与 ai_chat 行为一致(并列对照)", () => {
    const img = makeCard("ai_image", { imageUrl: "http://x/a.png" });
    const chat = makeCard("ai_chat", {});
    const script = makeCard("ai_script", {});
    [img, chat, script].forEach((c) => useCardStore.getState().addCard(c));
    expect(canAcceptConnection(chat.id, img.id)).toBe(canAcceptConnection(script.id, img.id));
  });
});
