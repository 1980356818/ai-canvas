import { describe, it, expect } from "vitest";
import {
  extractJsonBlock,
  parseInsights,
  parseScript,
  validateScriptWarnings,
  ScriptParseError,
} from "@/lib/scriptParse";
import type { ProductInsights, StoryboardScript } from "@/lib/scriptModel";

const INSIGHTS = {
  detected: true,
  productName: "LOFANS 朗菲便携式香薰风扇",
  category: "生活电器/便携风扇",
  features: ["内置香薰棉", "Type-C 充电"],
  sellingPoints: ["香薰清凉双效合一"],
  targetAudience: ["办公室白领"],
  usageScenarios: ["户外露营"],
  elements: [
    { mention: "图1", type: "image", role: "主体参考", product_related: true, description: "手持白色便携风扇正面" },
  ],
};

const SCRIPT = {
  title: "15秒便携香薰风扇种草",
  summary: "夏日户外降温神器",
  overview: { styleKeywords: ["清爽治愈", "夏日户外"], note: "一镜到底" },
  scenes: [{ name: "户外露营桌", setup: "野餐布与风扇", lighting: "明亮自然光", mentionRefs: ["图1"] }],
  shots: [
    { timeRange: "0-6s", shotType: "特写", cameraMove: "向前推", sceneDialogue: "展示风扇（参考 @图1）", voiceover: "太凉快了", tone: "轻快闺蜜语气", audioBgm: "轻快" },
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
  it("解析合法商品洞察(新 elements 结构)", () => {
    const r = parseInsights(JSON.stringify(INSIGHTS));
    expect(r.detected).toBe(true);
    expect(r.productName).toBe(INSIGHTS.productName);
    expect(r.features).toEqual(INSIGHTS.features);
    expect(r.elements[0]).toEqual({
      mention: "图1",
      type: "image",
      role: "主体参考",
      productRelated: true,
      description: "手持白色便携风扇正面",
    });
  });
  it("迁移老 materials:[{ref}] → elements", () => {
    const raw = JSON.stringify({ productName: "x", materials: [{ ref: "图片1", description: "正面" }] });
    const r = parseInsights(raw);
    expect(r.elements[0]!.mention).toBe("图1"); // 图片1 归一化为 图1
    expect(r.elements[0]!.type).toBe("image");
  });
  it("容忍 fence + 前后文字", () => {
    const raw = "分析完成：\n```json\n" + JSON.stringify(INSIGHTS) + "\n```\n以上。";
    expect(parseInsights(raw).category).toBe(INSIGHTS.category);
  });
  it("字符串当数组也能兜底", () => {
    const raw = JSON.stringify({ productName: "x", features: "单条特性" });
    expect(parseInsights(raw).features).toEqual(["单条特性"]);
  });
  it("只有素材(无商品)也算有效 + detected 推断 false", () => {
    const r = parseInsights(JSON.stringify({ elements: [{ mention: "视频1", description: "模特走动" }] }));
    expect(r.detected).toBe(false);
    expect(r.elements[0]!.type).toBe("video");
  });
  it("全空内容抛错(触发重试)", () => {
    expect(() => parseInsights("{}")).toThrow(ScriptParseError);
    expect(() => parseInsights("这不是 JSON")).toThrow(ScriptParseError);
  });
});

describe("parseScript", () => {
  it("解析合法分镜脚本(title/summary/scenes/tone/mentionRefs)", () => {
    const r = parseScript(JSON.stringify(SCRIPT));
    expect(r.title).toBe("15秒便携香薰风扇种草");
    expect(r.summary).toBe("夏日户外降温神器");
    expect(r.overview.styleKeywords).toEqual(["清爽治愈", "夏日户外"]);
    expect(r.scenes[0]!.setup).toBe("野餐布与风扇");
    expect(r.shots).toHaveLength(1);
    expect(r.shots[0]!.tone).toBe("轻快闺蜜语气");
    expect(r.shots[0]!.mentionRefs).toEqual(["图1"]); // 从对白 @图1 抽取
  });
  it("容忍 fence + 解释文字", () => {
    const raw = "脚本如下:\n```\n" + JSON.stringify(SCRIPT) + "\n```";
    expect(parseScript(raw).shots[0]!.timeRange).toBe("0-6s");
  });
  it("迁移老 sceneLighting 单对象 + 备用字段名", () => {
    const raw = JSON.stringify({
      overview: { keywords: ["k"], description: "d" },
      sceneLighting: { location: "loc", light: "li" },
      shots: [{ time: "0-5s", shot: "全景", camera: "摇", action: "走位", narration: "旁白", sound: "BGM" }],
    });
    const r = parseScript(raw);
    expect(r.overview.styleKeywords).toEqual(["k"]);
    expect(r.scenes[0]!.setup).toBe("loc");
    expect(r.scenes[0]!.lighting).toBe("li");
    expect(r.shots[0]!.shotType).toBe("全景");
    expect(r.shots[0]!.voiceover).toBe("旁白");
  });
  it("无有效镜头抛错", () => {
    expect(() => parseScript(JSON.stringify({ overview: {}, shots: [] }))).toThrow(ScriptParseError);
    expect(() => parseScript("没有 JSON")).toThrow(ScriptParseError);
  });
});

describe("validateScriptWarnings", () => {
  const goodScript: StoryboardScript = {
    title: "t",
    summary: "s",
    overview: { styleKeywords: [], note: "" },
    scenes: [],
    shots: [
      { timeRange: "0-6s", shotType: "", cameraMove: "", sceneDialogue: "参考 @图1", voiceover: "", audioBgm: "", mentionRefs: ["图1"] },
      { timeRange: "6-12s", shotType: "", cameraMove: "", sceneDialogue: "", voiceover: "", audioBgm: "" },
    ],
  };
  const insights: ProductInsights = {
    detected: true, productName: "x", category: "", features: [], sellingPoints: [],
    targetAudience: [], usageScenarios: [],
    elements: [{ mention: "图1", type: "image", description: "d" }],
  };

  it("合法脚本无 warnings", () => {
    expect(validateScriptWarnings(goodScript, insights)).toEqual([]);
  });
  it("镜头时长越界(>15s)告警", () => {
    const bad = { ...goodScript, shots: [{ ...goodScript.shots[0]!, timeRange: "0-20s" }] };
    const w = validateScriptWarnings(bad, insights);
    expect(w.some((x) => x.includes("超出"))).toBe(true);
  });
  it("时间轴断裂告警", () => {
    const bad = {
      ...goodScript,
      shots: [
        { ...goodScript.shots[0]!, timeRange: "0-6s" },
        { ...goodScript.shots[1]!, timeRange: "9-15s" },
      ],
    };
    expect(validateScriptWarnings(bad, insights).some((x) => x.includes("不连续"))).toBe(true);
  });
  it("引用越白名单标签告警", () => {
    const bad = {
      ...goodScript,
      shots: [{ ...goodScript.shots[0]!, sceneDialogue: "参考 @图9", mentionRefs: ["图9"] }],
    };
    expect(validateScriptWarnings(bad, insights).some((x) => x.includes("图9"))).toBe(true);
  });
});
