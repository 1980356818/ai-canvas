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

import { runScriptAnalyze, runScriptGenerate, reconcileElements } from "@/services/script/runScriptSteps";

function makeCard(data: Record<string, unknown>): CanvasCard {
  return {
    id: "card-1", projectId: "p1", type: "ai_script",
    x: 0, y: 0, width: 460, height: 360, zIndex: 1,
    locked: false, collapsed: false, data,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as CanvasCard;
}

const INSIGHTS_JSON = JSON.stringify({
  detected: true, productName: "朗菲风扇", category: "便携风扇",
  features: ["香薰", "Type-C"], sellingPoints: ["清凉"],
  targetAudience: ["白领"], usageScenarios: ["露营"], elements: [],
});

const SCRIPT_JSON = JSON.stringify({
  title: "便携香薰风扇", summary: "夏日降温",
  overview: { styleKeywords: ["清爽"], note: "一镜到底" },
  scenes: [{ name: "户外", setup: "野餐布", lighting: "自然光" }],
  shots: [{ timeRange: "0-6s", shotType: "特写", cameraMove: "推", sceneDialogue: "展示", voiceover: "太凉快了", tone: "轻快", audioBgm: "轻快" }],
});

const card = makeCard({ model: "test-model", provider: "test" });
const insights: ProductInsights = {
  detected: true, productName: "朗菲风扇", category: "便携风扇", features: [], sellingPoints: [],
  targetAudience: [], usageScenarios: [], elements: [],
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

describe("reconcileElements", () => {
  it("丢弃越界标签、按清单补齐遗漏、type 以清单为准", () => {
    const parsed = [
      { mention: "图1", type: "image" as const, description: "正面", productRelated: true },
      { mention: "图9", type: "image" as const, description: "瞎编的" }, // 不在清单 → 丢弃
    ];
    const manifest = [
      { mention: "图1", type: "image" as const },
      { mention: "视频1", type: "video" as const }, // 模型漏了 → 补空
    ];
    const r = reconcileElements(parsed, manifest);
    expect(r.map((e) => e.mention)).toEqual(["图1", "视频1"]);
    expect(r[0]!.description).toBe("正面");
    expect(r[1]!.description).toBe("");
    expect(r[1]!.type).toBe("video");
  });
  it("清单为空 → 原样返回", () => {
    const parsed = [{ mention: "图1", type: "image" as const, description: "x" }];
    expect(reconcileElements(parsed, [])).toEqual(parsed);
  });
});
