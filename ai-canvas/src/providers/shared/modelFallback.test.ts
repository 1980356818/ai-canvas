import { describe, it, expect } from "vitest";
import {
  splitModelFallbacks,
  isRouteUnconfiguredResponse,
  applyModelFallback,
  MODEL_FALLBACKS_FIELD,
} from "./modelFallback";

describe("splitModelFallbacks", () => {
  it("剥离 _modelFallbacks,返回干净 body + 候选列表", () => {
    const { body, fallbacks } = splitModelFallbacks({
      model: "gpt-image-2-medium-2k",
      size: "2048x2048",
      [MODEL_FALLBACKS_FIELD]: [{ model: "gpt-image-2-medium-1k", size: "1024x1024" }],
    });
    expect(body).toEqual({ model: "gpt-image-2-medium-2k", size: "2048x2048" });
    expect(body[MODEL_FALLBACKS_FIELD]).toBeUndefined();
    expect(fallbacks).toEqual([{ model: "gpt-image-2-medium-1k", size: "1024x1024" }]);
  });

  it("无该字段 → fallbacks 为空,原 body 原样(同引用)", () => {
    const input = { model: "nano-banana-2" };
    const { body, fallbacks } = splitModelFallbacks(input);
    expect(fallbacks).toEqual([]);
    expect(body).toBe(input);
  });

  it("空数组 → fallbacks 为空", () => {
    const { fallbacks } = splitModelFallbacks({ model: "x", [MODEL_FALLBACKS_FIELD]: [] });
    expect(fallbacks).toEqual([]);
  });

  it("过滤掉缺 model 的非法候选", () => {
    const { fallbacks } = splitModelFallbacks({
      model: "x",
      [MODEL_FALLBACKS_FIELD]: [{ size: "1024x1024" }, { model: "ok" }, null],
    });
    expect(fallbacks).toEqual([{ model: "ok" }]);
  });
});

describe("isRouteUnconfiguredResponse", () => {
  it("极境:4xx + 含「未配置路由」→ true", () => {
    expect(
      isRouteUnconfiguredResponse({
        status: 400,
        body: '{"error":{"message":"模型[gpt-image-2-medium-2k]未配置路由"}}',
      }),
    ).toBe(true);
  });

  it("极境:截断成「未配置路」仍命中", () => {
    expect(isRouteUnconfiguredResponse({ status: 400, body: "…未配置路" })).toBe(true);
  });

  it("New API:「…无可用渠道」→ true", () => {
    expect(
      isRouteUnconfiguredResponse({
        status: 400,
        body: "当前分组 default 下对于模型 gpt-image-2-medium-2k 无可用渠道",
      }),
    ).toBe(true);
  });

  it("2xx 即使文案巧合也不命中(只在错误响应触发)", () => {
    expect(isRouteUnconfiguredResponse({ status: 200, body: "未配置路由" })).toBe(false);
  });

  it("其它 4xx 错误(余额/限流/内容)不命中,不会误降级", () => {
    expect(isRouteUnconfiguredResponse({ status: 400, body: "余额不足" })).toBe(false);
    expect(isRouteUnconfiguredResponse({ status: 429, body: "请求过于频繁" })).toBe(false);
  });
});

describe("applyModelFallback", () => {
  it("换 model + size,保留其它字段(如已上传参考图)", () => {
    const out = applyModelFallback(
      { model: "gpt-image-2-medium-2k", size: "2048x2048", images: ["http://a"], prompt: "p" },
      { model: "gpt-image-2-medium-1k", size: "1024x1024" },
    );
    expect(out).toEqual({
      model: "gpt-image-2-medium-1k",
      size: "1024x1024",
      images: ["http://a"],
      prompt: "p",
    });
  });

  it("候选无 size → 只换 model,size 沿用原值", () => {
    const out = applyModelFallback(
      { model: "a", size: "2048x2048" },
      { model: "b" },
    );
    expect(out).toEqual({ model: "b", size: "2048x2048" });
  });
});
