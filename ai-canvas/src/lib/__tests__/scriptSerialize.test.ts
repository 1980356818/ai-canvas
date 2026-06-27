import { describe, it, expect } from "vitest";
import { scriptToMarkdown } from "@/lib/scriptSerialize";
import type { StoryboardScript, ProductInsights } from "@/lib/scriptModel";

const SCRIPT: StoryboardScript = {
  overview: { styleKeywords: ["清爽治愈", "夏日户外"], note: "一镜到底" },
  sceneLighting: { scene: "户外露营桌", lighting: "明亮自然光" },
  shots: [
    { timeRange: "0-3s", shotType: "特写", cameraMove: "向前推", sceneDialogue: "展示风扇", voiceover: "太凉快了", audioBgm: "轻快" },
    { timeRange: "3-7s", shotType: "中景", cameraMove: "环绕", sceneDialogue: "手持旋转", voiceover: "自带香薰", audioBgm: "海岛风" },
  ],
};

describe("scriptToMarkdown", () => {
  it("输出含总览/场景/逐镜结构", () => {
    const md = scriptToMarkdown(SCRIPT);
    expect(md).toContain("## 视频总览");
    expect(md).toContain("清爽治愈、夏日户外");
    expect(md).toContain("## 场景与光线");
    expect(md).toContain("## 逐秒镜头拆解");
    expect(md).toContain("### 0-3s");
    expect(md).toContain("口播旁白：太凉快了");
    expect(md).toContain("### 3-7s");
  });
  it("带商品名做标题", () => {
    const insights = { productName: "朗菲风扇" } as ProductInsights;
    expect(scriptToMarkdown(SCRIPT, insights)).toContain("# 朗菲风扇 · 视频脚本");
  });
  it("空字段不输出对应行", () => {
    const md = scriptToMarkdown({
      overview: { styleKeywords: [], note: "" },
      sceneLighting: { scene: "", lighting: "" },
      shots: [{ timeRange: "0-3s", shotType: "特写", cameraMove: "", sceneDialogue: "", voiceover: "", audioBgm: "" }],
    });
    expect(md).not.toContain("## 场景与光线");
    expect(md).not.toContain("运镜：");
    expect(md).toContain("景别/角度：特写");
  });
});
