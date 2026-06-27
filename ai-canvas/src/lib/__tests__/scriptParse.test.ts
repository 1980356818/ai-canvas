import { describe, it, expect } from "vitest";
import { extractJsonBlock, parseInsights, parseScript, ScriptParseError } from "@/lib/scriptParse";

const INSIGHTS = {
  productName: "LOFANS 朗菲便携式香薰风扇",
  category: "生活电器/便携风扇",
  features: ["内置香薰棉", "Type-C 充电"],
  sellingPoints: ["香薰清凉双效合一"],
  targetAudience: ["办公室白领"],
  usageScenarios: ["户外露营"],
  materials: [{ ref: "图1", description: "手持白色便携风扇正面" }],
};

const SCRIPT = {
  overview: { styleKeywords: ["清爽治愈", "夏日户外"], note: "一镜到底" },
  sceneLighting: { scene: "户外露营桌", lighting: "明亮自然光" },
  shots: [
    { timeRange: "0-3s", shotType: "特写", cameraMove: "向前推", sceneDialogue: "展示风扇", voiceover: "太凉快了", audioBgm: "轻快" },
  ],
};

describe("extractJsonBlock", () => {
  it("抽取裸 JSON 对象", () => {
    expect(extractJsonBlock('{"a":1}')).toBe('{"a":1}');
  });
  it("剥离 ```json 代码块", () => {
    expect(extractJsonBlock('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it("剥离前后解释文字", () => {
    expect(extractJsonBlock('好的，结果如下：{"a":1}。完毕')).toBe('{"a":1}');
  });
  it("处理嵌套与字符串内的花括号", () => {
    const s = '{"a":{"b":2},"c":"含 } 的文本"}';
    expect(extractJsonBlock("噪声" + s + "尾巴")).toBe(s);
  });
  it("无 JSON 返回 null", () => {
    expect(extractJsonBlock("纯文字没有结构")).toBeNull();
    expect(extractJsonBlock("")).toBeNull();
  });
});

describe("parseInsights", () => {
  it("解析合法商品洞察", () => {
    const r = parseInsights(JSON.stringify(INSIGHTS));
    expect(r.productName).toBe(INSIGHTS.productName);
    expect(r.features).toEqual(INSIGHTS.features);
    expect(r.materials[0]).toEqual({ ref: "图1", description: "手持白色便携风扇正面" });
  });
  it("容忍 fence + 前后文字", () => {
    const raw = "分析完成：\n```json\n" + JSON.stringify(INSIGHTS) + "\n```\n以上。";
    expect(parseInsights(raw).category).toBe(INSIGHTS.category);
  });
  it("字符串当数组也能兜底", () => {
    const raw = JSON.stringify({ productName: "x", features: "单条特性" });
    expect(parseInsights(raw).features).toEqual(["单条特性"]);
  });
  it("缺字段给空数组/空串", () => {
    const r = parseInsights(JSON.stringify({ productName: "只有名字" }));
    expect(r.sellingPoints).toEqual([]);
    expect(r.category).toBe("");
  });
  it("全空内容抛错(触发重试)", () => {
    expect(() => parseInsights("{}")).toThrow(ScriptParseError);
    expect(() => parseInsights("这不是 JSON")).toThrow(ScriptParseError);
  });
});

describe("parseScript", () => {
  it("解析合法分镜脚本", () => {
    const r = parseScript(JSON.stringify(SCRIPT));
    expect(r.overview.styleKeywords).toEqual(["清爽治愈", "夏日户外"]);
    expect(r.shots).toHaveLength(1);
    expect(r.shots[0]!.voiceover).toBe("太凉快了");
  });
  it("容忍 fence + 解释文字", () => {
    const raw = "脚本如下:\n```\n" + JSON.stringify(SCRIPT) + "\n```";
    expect(parseScript(raw).shots[0]!.timeRange).toBe("0-3s");
  });
  it("兼容备用字段名(shot/camera/narration)", () => {
    const raw = JSON.stringify({
      overview: { keywords: ["k"], description: "d" },
      scene: { location: "loc", light: "li" },
      shots: [{ time: "0-2s", shot: "全景", camera: "摇", action: "走位", narration: "旁白", sound: "BGM" }],
    });
    const r = parseScript(raw);
    expect(r.overview.styleKeywords).toEqual(["k"]);
    expect(r.sceneLighting.scene).toBe("loc");
    expect(r.shots[0]!.shotType).toBe("全景");
    expect(r.shots[0]!.voiceover).toBe("旁白");
  });
  it("无有效镜头抛错", () => {
    expect(() => parseScript(JSON.stringify({ overview: {}, shots: [] }))).toThrow(ScriptParseError);
    expect(() => parseScript("没有 JSON")).toThrow(ScriptParseError);
  });
});
