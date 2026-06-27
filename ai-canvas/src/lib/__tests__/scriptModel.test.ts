import { describe, it, expect } from "vitest";
import {
  coerceInsights,
  coerceScript,
  normalizeInsights,
  normalizeScript,
  normalizeMention,
  extractMentions,
} from "@/lib/scriptModel";

describe("normalizeMention / extractMentions", () => {
  it("归一化:去 @、图片N→图N", () => {
    expect(normalizeMention("@图片1")).toBe("图1");
    expect(normalizeMention("视频2")).toBe("视频2");
  });
  it("从文字抽引用标签、去重保序、图片→图", () => {
    expect(extractMentions("参考 @图1 与 @视频2，再看 @图片3 和 @图1")).toEqual(["图1", "视频2", "图3"]);
  });
  it("无引用返回空", () => {
    expect(extractMentions("没有任何引用")).toEqual([]);
  });
});

describe("coerceInsights 迁移", () => {
  it("老 materials → elements，detected 由 productName 推断", () => {
    const r = coerceInsights({
      productName: "风扇",
      materials: [{ ref: "图1", description: "正面" }, { ref: "视频1", description: "演示" }],
    });
    expect(r.detected).toBe(true);
    expect(r.elements.map((e) => e.mention)).toEqual(["图1", "视频1"]);
    expect(r.elements[1]!.type).toBe("video");
  });
  it("新 elements 结构幂等 + product_related→productRelated", () => {
    const r = coerceInsights({
      detected: false,
      elements: [{ mention: "图1", type: "image", role: "主体", product_related: true, description: "d" }],
    });
    expect(r.detected).toBe(false);
    expect(r.elements[0]!.productRelated).toBe(true);
    expect(r.elements[0]!.role).toBe("主体");
  });
});

describe("coerceScript 迁移", () => {
  it("老 sceneLighting 单对象 → scenes 数组", () => {
    const r = coerceScript({
      sceneLighting: { scene: "户外", lighting: "自然光" },
      shots: [{ timeRange: "0-5s", sceneDialogue: "x" }],
    });
    expect(r.scenes).toHaveLength(1);
    expect(r.scenes[0]!.setup).toBe("户外");
    expect(r.scenes[0]!.lighting).toBe("自然光");
  });
  it("从对白回填 shot.mentionRefs", () => {
    const r = coerceScript({
      shots: [{ timeRange: "0-5s", sceneDialogue: "参考 @图2 背面", voiceover: "看 @视频1" }],
    });
    expect(r.shots[0]!.mentionRefs).toEqual(["图2", "视频1"]);
  });
});

describe("normalizeInsights / normalizeScript", () => {
  it("空/无效 → null", () => {
    expect(normalizeInsights(undefined)).toBeNull();
    expect(normalizeInsights({})).toBeNull();
    expect(normalizeScript(undefined)).toBeNull();
    expect(normalizeScript({ shots: [] })).toBeNull();
  });
  it("老持久化 insights → 规范结构", () => {
    const r = normalizeInsights({ productName: "x", materials: [{ ref: "图1", description: "d" }] });
    expect(r?.elements[0]!.mention).toBe("图1");
  });
  it("老持久化 script → 规范结构(含镜头才有效)", () => {
    const r = normalizeScript({
      sceneLighting: { scene: "s", lighting: "l" },
      shots: [{ timeRange: "0-5s", sceneDialogue: "x" }],
    });
    expect(r?.scenes[0]!.setup).toBe("s");
    expect(r?.shots).toHaveLength(1);
  });
});
