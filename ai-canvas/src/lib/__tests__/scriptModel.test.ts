import { describe, it, expect } from "vitest";
import { normalizeMention, extractMentions } from "@/lib/scriptModel";

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
