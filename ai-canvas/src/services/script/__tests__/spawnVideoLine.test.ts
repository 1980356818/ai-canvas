/**
 * P2 铺下游 ai_video 生产线单测(mock stores/platform/refSources)。
 * 验证:解析逐镜 → 每镜建一张 ai_video(预填提示词/模型/reference 模式)+ @图N 连到正确源卡。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CanvasCard } from "@/types";

const { addCardMock, addConnsMock } = vi.hoisted(() => ({
  addCardMock: vi.fn(),
  addConnsMock: vi.fn(),
}));

vi.mock("@/stores/cardStore", () => ({
  useCardStore: { getState: () => ({ addCard: addCardMock, maxZIndex: 10 }) },
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: { getState: () => ({ addConnections: addConnsMock }) },
}));
vi.mock("@/platform", () => ({
  saveCardsBatch: vi.fn(async () => {}),
  saveConnections: vi.fn(async () => {}),
}));
vi.mock("@/lib/mappers", () => ({ cardToRow: (c: unknown) => c, connectionToRow: (c: unknown) => c }));
vi.mock("@/services/modelDefaults", () => ({
  resolveDefaultModelForCardType: vi.fn(async () => ({ modelId: "seedance-v2", providerId: "jijing" })),
}));
vi.mock("@/config/model-ref-images", () => ({ getRefSlotsForChatModel: vi.fn(() => []) }));
vi.mock("@/hooks/useImageRefSources", () => ({
  computeImageRefSources: vi.fn(() => [
    { id: "slot:refImage0", label: "图1", category: "slot", thumbnailUrl: "", resolvedUrl: "u1", source: { type: "refSlot", slotKey: "refImage0" } },
    { id: "upstream:img2", label: "图2", category: "upstream", thumbnailUrl: "", resolvedUrl: "u2", source: { type: "upstream", sourceCardId: "img2-card" } },
  ]),
}));

import { spawnVideoLineFromScript } from "@/services/script/spawnVideoLine";

const MD = `五、Seedance 2.0 分镜提示词

## 镜头1：
- 参考图：@图1
- 中文视频提示词：场景A，模特展示，参考 @图1。画面无字幕。

## 镜头2：
- 参考图：@图2
- 中文视频提示词：场景B，街边行走，参考 @图2。画面无字幕。`;

function scriptCard(result: string): CanvasCard {
  return {
    id: "script-1", projectId: "p1", type: "ai_script",
    x: 100, y: 200, width: 720, height: 520, zIndex: 5,
    locked: false, collapsed: false,
    data: { model: "gpt-5.5-medium", refImages: { refImage0: { url: "u1", sourceCardId: "img1-card" } }, result },
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as CanvasCard;
}

beforeEach(() => { addCardMock.mockReset(); addConnsMock.mockReset(); });

describe("spawnVideoLineFromScript", () => {
  it("每镜建一张 ai_video,预填提示词/模型/reference 模式", async () => {
    const r = await spawnVideoLineFromScript(scriptCard(MD));
    expect(r).toEqual({ shots: 2, created: 2, connected: 2 });
    expect(addCardMock).toHaveBeenCalledTimes(2);

    const cards = addCardMock.mock.calls.map((c) => c[0] as CanvasCard);
    expect(cards[0]!.type).toBe("ai_video");
    expect((cards[0]!.data as Record<string, unknown>).content).toContain("场景A");
    expect((cards[0]!.data as Record<string, unknown>).model).toBe("seedance-v2");
    expect((cards[0]!.data as Record<string, unknown>).imageMode).toBe("reference");
    expect(cards[0]!.title).toBe("镜头 1");
    expect(cards[0]!.zIndex).toBe(11); // maxZIndex 10 + 1
    expect(cards[1]!.zIndex).toBe(12);
    // 布局:落在源卡下方
    expect(cards[0]!.y).toBeGreaterThan(200 + 520);
  });

  it("@图N 连到正确源卡(refSlot→entry.sourceCardId / upstream→sourceCardId)", async () => {
    await spawnVideoLineFromScript(scriptCard(MD));
    expect(addConnsMock).toHaveBeenCalledTimes(1);
    const conns = addConnsMock.mock.calls[0]![0] as { sourceCardId: string; targetCardId: string }[];
    expect(conns).toHaveLength(2);
    const cards = addCardMock.mock.calls.map((c) => c[0] as CanvasCard);
    const byTarget = new Map(conns.map((c) => [c.targetCardId, c.sourceCardId]));
    expect(byTarget.get(cards[0]!.id)).toBe("img1-card"); // 图1 = refImage0.sourceCardId
    expect(byTarget.get(cards[1]!.id)).toBe("img2-card"); // 图2 = upstream sourceCardId
  });

  it("无逐镜 → 不建卡、不连线", async () => {
    const r = await spawnVideoLineFromScript(scriptCard("一段没有分镜结构的普通文本。"));
    expect(r).toEqual({ shots: 0, created: 0, connected: 0 });
    expect(addCardMock).not.toHaveBeenCalled();
    expect(addConnsMock).not.toHaveBeenCalled();
  });
});
