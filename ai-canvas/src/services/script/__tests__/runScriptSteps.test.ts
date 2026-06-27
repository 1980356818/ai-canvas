/**
 * 「帮我写」服务层全链路单测(mock 掉网络/翻译层)。
 * 验证:合成卡 → buildChatRequest → streamChatToResult → 解析；以及 JSON 失败重试一次的契约。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CanvasCard } from "@/types";
import { DEFAULT_SCRIPT_CONFIG, type ProductInsights } from "@/lib/scriptModel";

const { streamMock, buildMock } = vi.hoisted(() => ({
  streamMock: vi.fn(),
  buildMock: vi.fn(async () => ({
    ok: true as const,
    request: { model: "test-model", systemPrompt: "", messages: [], maxTokens: 100 },
    providerId: "test",
  })),
}));

vi.mock("@/services/generation/buildChatRequest", () => ({ buildChatRequest: buildMock }));
vi.mock("@/services/generation/streamChatToResult", () => ({ streamChatToResult: streamMock }));
vi.mock("@/services/models", () => ({ modelService: { resolveProvider: vi.fn(() => ({})) } }));

import { runScriptAnalyze, runScriptGenerate } from "@/services/script/runScriptSteps";

function makeCard(data: Record<string, unknown>): CanvasCard {
  return {
    id: "card-1", projectId: "p1", type: "ai_script",
    x: 0, y: 0, width: 460, height: 360, zIndex: 1,
    locked: false, collapsed: false, data,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as CanvasCard;
}

const INSIGHTS_JSON = JSON.stringify({
  productName: "朗菲风扇", category: "便携风扇",
  features: ["香薰", "Type-C"], sellingPoints: ["清凉"],
  targetAudience: ["白领"], usageScenarios: ["露营"], materials: [],
});

const SCRIPT_JSON = JSON.stringify({
  overview: { styleKeywords: ["清爽"], note: "一镜到底" },
  sceneLighting: { scene: "户外", lighting: "自然光" },
  shots: [{ timeRange: "0-3s", shotType: "特写", cameraMove: "推", sceneDialogue: "展示", voiceover: "太凉快了", audioBgm: "轻快" }],
});

const card = makeCard({ model: "test-model", provider: "test" });
const insights: ProductInsights = {
  productName: "朗菲风扇", category: "便携风扇", features: [], sellingPoints: [],
  targetAudience: [], usageScenarios: [], materials: [],
};

beforeEach(() => {
  streamMock.mockReset();
  buildMock.mockClear();
});

describe("runScriptAnalyze", () => {
  it("解析出商品洞察", async () => {
    streamMock.mockResolvedValue({ content: INSIGHTS_JSON, finishReason: "stop" });
    const r = await runScriptAnalyze(card);
    expect(r.productName).toBe("朗菲风扇");
    expect(r.features).toEqual(["香薰", "Type-C"]);
    expect(streamMock).toHaveBeenCalledTimes(1);
  });

  it("首次非法 JSON → 自动重试一次成功", async () => {
    streamMock
      .mockResolvedValueOnce({ content: "抱歉，我先解释一下……", finishReason: "stop" })
      .mockResolvedValueOnce({ content: INSIGHTS_JSON, finishReason: "stop" });
    const r = await runScriptAnalyze(card);
    expect(r.productName).toBe("朗菲风扇");
    expect(streamMock).toHaveBeenCalledTimes(2);
  });

  it("两次都非法 → 抛错且只重试一次", async () => {
    streamMock.mockResolvedValue({ content: "没有 JSON", finishReason: "stop" });
    await expect(runScriptAnalyze(card)).rejects.toThrow();
    expect(streamMock).toHaveBeenCalledTimes(2);
  });
});

describe("runScriptGenerate", () => {
  it("解析出分镜脚本", async () => {
    streamMock.mockResolvedValue({ content: SCRIPT_JSON, finishReason: "stop" });
    const s = await runScriptGenerate(card, insights, DEFAULT_SCRIPT_CONFIG, undefined);
    expect(s.shots).toHaveLength(1);
    expect(s.shots[0]!.voiceover).toBe("太凉快了");
    expect(s.overview.styleKeywords).toEqual(["清爽"]);
  });
});
