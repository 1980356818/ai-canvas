import { describe, it, expect } from "vitest";
import { parseSeedanceShots } from "@/lib/scriptShots";

// 对照真网关实测的「五、Seedance 2.0 分镜提示词」格式。
const REAL = `四、分镜脚本

| 镜头 | 时长 | 使用参考图 | 画面内容 |
|---|---:|---|---|
| 1 | 4秒 | @图1 | 衣架前拿起衬衫 |
| 2 | 5秒 | @图1 | 窗边整理翻领 |

五、Seedance 2.0 分镜提示词

## 镜头1：
- 时长：4秒
- 参考图：@图1
- 中文视频提示词：
  场景为自然光卧室衣架前，商品浅米色竖条纹短袖衬衫位于衣架中间，手部拿起衬衫。镜头轻微推近。画面中无字幕、无新增文字、无价格牌。
- 声音内容：
  旁白：夏天出门，我会先拿这件。
- 商品保持要求：保持商品颜色、外形、Logo 不变。
- 画面禁止内容：禁止出现字幕、价格、促销标签。
- 镜头衔接建议：切到窗边镜头。

---

## 镜头2：
- 时长：5秒
- 参考图：@图2
- 中文视频提示词：窗边模特穿衬衫整理翻领，参考 @图2 背面细节，半身正面。画面无字幕。
- 声音内容：旁白：浅米色加棕橙竖纹。

---

六、完整视频生成总提示词

生成一条 30 秒电商种草短视频……（不应被当作镜头）`;

describe("parseSeedanceShots", () => {
  it("抽出逐镜 镜头号/参考图/提示词/时长", () => {
    const shots = parseSeedanceShots(REAL);
    expect(shots).toHaveLength(2);

    expect(shots[0]!.shotNo).toBe(1);
    expect(shots[0]!.refs).toEqual(["图1"]);
    expect(shots[0]!.duration).toBe("4秒");
    expect(shots[0]!.prompt).toContain("场景为自然光卧室衣架前");
    expect(shots[0]!.prompt).toContain("无字幕"); // 续行被并入
    expect(shots[0]!.prompt).not.toContain("旁白"); // 声音内容不混入

    expect(shots[1]!.shotNo).toBe(2);
    expect(shots[1]!.refs).toEqual(["图2"]); // 参考图 + 正文 @图2 去重
    expect(shots[1]!.prompt).toContain("窗边模特穿衬衫");
  });

  it("第四段表格的 |镜头| 行不会被当成镜头", () => {
    // REAL 里表格在前,结果仍恰好 2 镜(全来自第五段)。
    expect(parseSeedanceShots(REAL).every((s) => s.prompt.length > 0)).toBe(true);
  });

  it("多个参考图都抽出", () => {
    const md = `## 镜头1：
- 参考图：@图1、@视频1
- 中文视频提示词：参考 @图1 与 @视频1 动态。`;
    expect(parseSeedanceShots(md)[0]!.refs).toEqual(["图1", "视频1"]);
  });

  it("无中文视频提示词的块跳过", () => {
    const md = `## 镜头1：
- 时长：4秒
- 参考图：@图1`;
    expect(parseSeedanceShots(md)).toEqual([]);
  });

  it("空输入 / 无镜头 → 空数组(不抛错)", () => {
    expect(parseSeedanceShots("")).toEqual([]);
    expect(parseSeedanceShots("一段普通脚本，没有逐镜结构。")).toEqual([]);
  });
});
