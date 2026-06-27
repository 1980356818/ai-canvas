import { describe, it, expect } from "vitest";
import { scriptToMarkdown } from "@/lib/scriptSerialize";
import type { StoryboardScript, ProductInsights } from "@/lib/scriptModel";

const SCRIPT: StoryboardScript = {
  title: "",
  summary: "",
  overview: { styleKeywords: ["清爽治愈", "夏日户外"], note: "一镜到底" },
  scenes: [
    { name: "户外露营桌", setup: "野餐布与风扇", lighting: "明亮自然光" },
    { name: "白背景", setup: "无影台", lighting: "柔光" },
  ],
  shots: [
    { timeRange: "0-6s", shotType: "特写", cameraMove: "向前推", sceneDialogue: "展示风扇（参考 @图1）", voiceover: "太凉快了", tone: "轻快闺蜜语气", audioBgm: "轻快" },
    { timeRange: "6-12s", shotType: "中景", cameraMove: "环绕", sceneDialogue: "手持旋转", voiceover: "自带香薰", audioBgm: "海岛风" },
  ],
};

describe("scriptToMarkdown", () => {
  it("输出含总览/多场景/逐镜结构 + 语气 + @标签透传", () => {
    const md = scriptToMarkdown(SCRIPT);
    expect(md).toContain("## 视频总览");
    expect(md).toContain("清爽治愈、夏日户外");
    expect(md).toContain("## 场景与光线");
    expect(md).toContain("户外露营桌");
    expect(md).toContain("白背景"); // 多场景都输出
    expect(md).toContain("## 逐秒镜头拆解");
    expect(md).toContain("### 0-6s");
    expect(md).toContain("@图1"); // 素材标签原样透传
    expect(md).toContain("口播旁白（轻快闺蜜语气）：太凉快了"); // 带语气
    expect(md).toContain("口播旁白：自带香薰"); // 无语气不带括号
    expect(md).toContain("### 6-12s");
  });
  it("script.title 优先做标题", () => {
    expect(scriptToMarkdown({ ...SCRIPT, title: "我的脚本标题" })).toContain("# 我的脚本标题");
  });
  it("无 title 时用商品名做标题", () => {
    const insights = { productName: "朗菲风扇" } as ProductInsights;
    expect(scriptToMarkdown(SCRIPT, insights)).toContain("# 朗菲风扇 · 视频脚本");
  });
  it("summary 以引用块输出", () => {
    expect(scriptToMarkdown({ ...SCRIPT, summary: "夏日降温神器" })).toContain("> 夏日降温神器");
  });
  it("空字段不输出对应行", () => {
    const md = scriptToMarkdown({
      title: "",
      summary: "",
      overview: { styleKeywords: [], note: "" },
      scenes: [],
      shots: [{ timeRange: "0-6s", shotType: "特写", cameraMove: "", sceneDialogue: "", voiceover: "", audioBgm: "" }],
    });
    expect(md).not.toContain("## 场景与光线");
    expect(md).not.toContain("运镜：");
    expect(md).toContain("景别/角度：特写");
  });
});
