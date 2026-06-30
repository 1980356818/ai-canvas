import { describe, it, expect } from "vitest";
import { parseInsights, extractJsonBlock, ScriptParseError } from "@/lib/scriptParse";

describe("parseInsights", () => {
  it("解析干净 JSON", () => {
    const r = parseInsights(JSON.stringify({
      detected: true, productName: "风扇", category: "便携风扇",
      features: ["香薰"], sellingPoints: ["清凉"], targetAudience: ["白领"],
      usageScenarios: ["露营"], elements: [{ mention: "图1", type: "image", description: "正面" }],
    }));
    expect(r.productName).toBe("风扇");
    expect(r.detected).toBe(true);
    expect(r.elements[0]!.mention).toBe("图1");
  });

  it("去 ```json fence + 前后解释文字", () => {
    const raw = "好的：\n```json\n{\"productName\":\"裙子\",\"features\":[\"碎花\"]}\n```\n以上。";
    expect(parseInsights(raw).productName).toBe("裙子");
  });

  it("老 materials 结构迁移成 elements", () => {
    const r = parseInsights(JSON.stringify({ productName: "x", materials: [{ ref: "图1", description: "d" }] }));
    expect(r.elements[0]!.mention).toBe("图1");
  });

  it("全空 / 无 JSON → 抛 ScriptParseError", () => {
    expect(() => parseInsights("{}")).toThrow(ScriptParseError);
    expect(() => parseInsights("没有 JSON")).toThrow(ScriptParseError);
  });

  it("extractJsonBlock 平衡括号、跳字符串内括号", () => {
    expect(extractJsonBlock('前缀 {"a":{"b":1}} 后缀')).toBe('{"a":{"b":1}}');
    expect(extractJsonBlock('{"s":"内有 } 括号"}')).toBe('{"s":"内有 } 括号"}');
    expect(extractJsonBlock("无")).toBeNull();
  });
});
