import { describe, it, expect, vi, beforeEach } from "vitest";

// aiProxy 是唯一的出网口,mock 它即可驱动「未配置路由 → 降级重发」全链路。
const aiProxy = vi.fn();
vi.mock("@/platform", () => ({
  aiProxy: (...args: unknown[]) => aiProxy(...args),
  pollTask: vi.fn(),
  saveMedia: vi.fn(),
}));
// taskManager 单例会拖入 store/持久化;createMediaTaskHandler 运行时并不用它,stub 掉避免重依赖。
vi.mock("@/services/taskManager", () => ({
  taskManager: { registerHandler: vi.fn() },
}));

import { createMediaTaskHandler } from "./mediaHandler";
import { MODEL_FALLBACKS_FIELD } from "./modelFallback";

const ROUTE_UNCONFIGURED = {
  status: 400,
  body: JSON.stringify({ error: { message: "模型[gpt-image-2-medium-2k]未配置路由" } }),
};
const okWithUrl = (url: string) => ({ status: 200, body: JSON.stringify({ data: [{ url }] }) });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctxFor(request: Record<string, unknown>): any {
  return {
    task: { provider: "jijing", submitEndpoint: "/v1/images/generations", request },
    signal: new AbortController().signal,
    setProgress: () => {},
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const trySyncResult = (data: any) =>
  data?.data?.[0]?.url ? { url: data.data[0].url } : null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bodyOf = (callIndex: number) => aiProxy.mock.calls[callIndex]![2] as any;

describe("mediaHandler submit — 未配置路由静默降级", () => {
  beforeEach(() => aiProxy.mockReset());

  it("medium-2k 路由未配置 → 自动换 1k 重发并成功", async () => {
    aiProxy
      .mockResolvedValueOnce(ROUTE_UNCONFIGURED)
      .mockResolvedValueOnce(okWithUrl("https://cdn/y.png"));

    const handler = createMediaTaskHandler({ trySyncResult });
    const request = {
      model: "gpt-image-2-medium-2k",
      size: "2048x2048",
      prompt: "全身电商大片",
      [MODEL_FALLBACKS_FIELD]: [{ model: "gpt-image-2-medium-1k", size: "1024x1024" }],
    };

    const outcome = await handler.submit!(request, ctxFor(request));

    expect(aiProxy).toHaveBeenCalledTimes(2);
    // ① 先发 2k
    expect(bodyOf(0).model).toBe("gpt-image-2-medium-2k");
    expect(bodyOf(0).size).toBe("2048x2048");
    // ② 降级发 1k + 对应像素
    expect(bodyOf(1).model).toBe("gpt-image-2-medium-1k");
    expect(bodyOf(1).size).toBe("1024x1024");
    // 两次都不把内部控制字段外发给服务端
    expect(bodyOf(0)[MODEL_FALLBACKS_FIELD]).toBeUndefined();
    expect(bodyOf(1)[MODEL_FALLBACKS_FIELD]).toBeUndefined();
    expect(outcome).toEqual({ mode: "sync", result: { url: "https://cdn/y.png" } });
  });

  it("正常成功 → 不重发,且不外发控制字段", async () => {
    aiProxy.mockResolvedValueOnce(okWithUrl("https://cdn/ok.png"));
    const handler = createMediaTaskHandler({ trySyncResult });
    const request = {
      model: "gpt-image-2-medium-2k",
      size: "2048x2048",
      [MODEL_FALLBACKS_FIELD]: [{ model: "gpt-image-2-medium-1k", size: "1024x1024" }],
    };
    await handler.submit!(request, ctxFor(request));
    expect(aiProxy).toHaveBeenCalledTimes(1);
    expect(bodyOf(0)[MODEL_FALLBACKS_FIELD]).toBeUndefined();
  });

  it("非路由错误(余额不足 400)→ 不降级,直接抛错", async () => {
    aiProxy.mockResolvedValueOnce({
      status: 400,
      body: JSON.stringify({ error: { message: "余额不足,无法冻结" } }),
    });
    const handler = createMediaTaskHandler({ trySyncResult });
    const request = {
      model: "gpt-image-2-medium-2k",
      [MODEL_FALLBACKS_FIELD]: [{ model: "gpt-image-2-medium-1k", size: "1024x1024" }],
    };
    await expect(handler.submit!(request, ctxFor(request))).rejects.toThrow();
    expect(aiProxy).toHaveBeenCalledTimes(1);
  });

  it("降级后仍路由未配置 → 用尽候选,按最后一次错误抛出(不无限重试)", async () => {
    aiProxy
      .mockResolvedValueOnce(ROUTE_UNCONFIGURED)
      .mockResolvedValueOnce(ROUTE_UNCONFIGURED);
    const handler = createMediaTaskHandler({ trySyncResult });
    const request = {
      model: "gpt-image-2-medium-2k",
      [MODEL_FALLBACKS_FIELD]: [{ model: "gpt-image-2-medium-1k", size: "1024x1024" }],
    };
    await expect(handler.submit!(request, ctxFor(request))).rejects.toThrow();
    expect(aiProxy).toHaveBeenCalledTimes(2);
  });
});
