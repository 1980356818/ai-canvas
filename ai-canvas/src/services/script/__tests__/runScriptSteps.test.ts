/**
 * 「帮我写」生成编排单测（Seedance 单次调用 · markdown 直出）。
 * 验证:合成卡 → buildChatRequest(labelMedia) → streamChatToResult → 原文直出（不解析 JSON、不重试）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CanvasCard } from "@/types";
import { DEFAULT_SCRIPT_CONFIG, type ProductInsights } from "@/lib/scriptModel";
import { buildSeedanceUserPrompt, SEEDANCE_SCRIPT_SYSTEM_PROMPT } from "@/lib/scriptPrompts";

const { streamMock, buildMock } = vi.hoisted(() => ({
  streamMock: vi.fn(),
  buildMock: vi.fn(async () => ({
    ok: true as const,
    request: { model: "test-model", systemPrompt: "", messages: [], maxTokens: 65536 },
    providerId: "test",
  })),
}));

vi.mock("@/services/generation/buildChatRequest", () => ({ buildChatRequest: buildMock }));
vi.mock("@/services/generation/streamChatToResult", () => ({ streamChatToResult: streamMock }));
vi.mock("@/services/models", () => ({ modelService: { resolveProvider: vi.fn(() => ({})) } }));
vi.mock("@/hooks/useImageRefSources", () => ({ computeImageRefSources: vi.fn(() => []) }));
vi.mock("@/config/model-ref-images", () => ({ getRefSlotsForChatModel: vi.fn(() => []) }));

import { runScriptSeedance, runScriptAnalyze } from "@/services/script/runScriptSteps";

function makeCard(data: Record<string, unknown>): CanvasCard {
  return {
    id: "card-1", projectId: "p1", type: "ai_script",
    x: 0, y: 0, width: 460, height: 360, zIndex: 1,
    locked: false, collapsed: false, data,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as CanvasCard;
}

const card = makeCard({ model: "test-model", provider: "test" });

beforeEach(() => {
  streamMock.mockReset();
  buildMock.mockClear();
});

describe("runScriptSeedance · markdown 直出", () => {
  it("原样返回模型 markdown（不做 JSON 解析、不重试）", async () => {
    const md = "# 视频脚本\n\n## 四、分镜脚本\n| 镜头 | 时长 |\n| 1 | 0-5s |\n\n参考 @图1";
    streamMock.mockResolvedValue({ content: md, finishReason: "stop" });
    const r = await runScriptSeedance(card, DEFAULT_SCRIPT_CONFIG);
    expect(r).toBe(md);
    expect(streamMock).toHaveBeenCalledTimes(1);
  });

  it("非 JSON / 纯文本也不会抛错（创意写作永不解析失败）", async () => {
    streamMock.mockResolvedValue({ content: "这是一段普通说明文字，不是 JSON。", finishReason: "stop" });
    await expect(runScriptSeedance(card, DEFAULT_SCRIPT_CONFIG)).resolves.toContain("普通说明文字");
  });

  it("开启 labelMedia 喂带【图N】标签的素材", async () => {
    streamMock.mockResolvedValue({ content: "x", finishReason: "stop" });
    await runScriptSeedance(card, DEFAULT_SCRIPT_CONFIG);
    expect(buildMock).toHaveBeenCalledWith(expect.anything(), { labelMedia: true });
  });

  it("trim 掉首尾空白", async () => {
    streamMock.mockResolvedValue({ content: "  \n# 脚本\n  ", finishReason: "stop" });
    expect(await runScriptSeedance(card, DEFAULT_SCRIPT_CONFIG)).toBe("# 脚本");
  });
});

const INSIGHTS_JSON = JSON.stringify({
  detected: true, productName: "朗菲风扇", category: "便携风扇",
  features: ["香薰", "Type-C"], sellingPoints: ["清凉"], targetAudience: ["白领"],
  usageScenarios: ["露营"], elements: [{ mention: "图1", type: "image", description: "正面" }],
});

describe("runScriptAnalyze · JSON 商品洞察", () => {
  it("解析出商品洞察 + labelMedia", async () => {
    streamMock.mockResolvedValue({ content: INSIGHTS_JSON, finishReason: "stop" });
    const r = await runScriptAnalyze(card);
    expect(r.productName).toBe("朗菲风扇");
    expect(r.features).toEqual(["香薰", "Type-C"]);
    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(buildMock).toHaveBeenCalledWith(expect.anything(), { labelMedia: true });
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

describe("buildSeedanceUserPrompt", () => {
  it("把配置 + 素材清单填入用户输入", () => {
    const p = buildSeedanceUserPrompt(
      { business: "ecommerce", language: "zh", contentType: "hook", durationSeconds: 30, notes: "强调便携" },
      [{ mention: "图1", type: "image" }, { mention: "视频1", type: "video" }],
    );
    expect(p).toContain("电商带货");
    expect(p).toContain("中文");
    expect(p).toContain("卖点钩子");
    expect(p).toContain("30秒");
    expect(p).toContain("强调便携");
    expect(p).toContain("图1");
    expect(p).toContain("视频1");
  });

  it("无素材时给兜底说明", () => {
    expect(buildSeedanceUserPrompt(DEFAULT_SCRIPT_CONFIG, [])).toContain("【图N】");
  });

  it("带已确认洞察 → 前置「已确认的商品洞察」块", () => {
    const insights: ProductInsights = {
      detected: true, productName: "碎花连衣裙", category: "女装-连衣裙",
      features: ["碎花"], sellingPoints: ["显瘦"], targetAudience: ["女生"],
      usageScenarios: ["约会"], elements: [{ mention: "图1", type: "image", description: "正面" }],
    };
    const p = buildSeedanceUserPrompt(DEFAULT_SCRIPT_CONFIG, [{ mention: "图1", type: "image" }], insights);
    expect(p).toContain("已确认的商品洞察");
    expect(p).toContain("碎花连衣裙");
    expect(p).toContain("@图1");
    expect(p.indexOf("已确认的商品洞察")).toBeLessThan(p.indexOf("【用户输入】")); // 前置
  });

  it("系统提示词含关键约束", () => {
    expect(SEEDANCE_SCRIPT_SYSTEM_PROMPT).toContain("Seedance 2.0");
    expect(SEEDANCE_SCRIPT_SYSTEM_PROMPT).toContain("画面中禁止出现字幕");
  });
});
