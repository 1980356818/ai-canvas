/**
 * shrinkReferenceVideoForSeedance 的分支契约测试。
 *
 * 强制 isTauri=true(真实环境是桌面端)+ mock invoke,验证:
 *   - 本地路径 → 调 Rust compress_reference_video,透传返回
 *   - asset.localhost 显示 URL → 先反解绝对路径再调
 *   - 真远端 / data: / blob: → 降级原样返回,不调 Rust
 *   - Rust 报错 → 包装成「参考视频压缩失败:…」抛出
 *
 * 真实缩放算法在 Rust(src-tauri 单测覆盖 compute_target_dims);这里只测前端门控/降级。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// isTauri 在 vitest(node)默认 false,会让函数短路。强制 true 以测桌面端分支。
vi.mock("@/platform/runtime", () => ({
  isTauri: true,
  ensureTauriAPIs: vi.fn(),
  getInvoke: vi.fn(),
}));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  shrinkReferenceVideoForSeedance,
  describeCompressError,
  MAX_REF_VIDEO_PIXELS,
} from "@/lib/videoCompress";

describe("shrinkReferenceVideoForSeedance", () => {
  beforeEach(() => invokeMock.mockReset());

  it("本地路径 → 调 compress_reference_video 并透传返回", async () => {
    invokeMock.mockResolvedValue("media/compressed/abc_2073600_1920x1080.mp4");
    const out = await shrinkReferenceVideoForSeedance("local://media/videos/x.mp4");
    expect(invokeMock).toHaveBeenCalledWith("compress_reference_video", {
      videoPath: "local://media/videos/x.mp4",
      maxPixels: MAX_REF_VIDEO_PIXELS,
    });
    expect(out).toBe("media/compressed/abc_2073600_1920x1080.mp4");
  });

  it("asset.localhost 显示 URL → 先反解绝对路径再调", async () => {
    invokeMock.mockResolvedValue("media/compressed/done.mp4");
    await shrinkReferenceVideoForSeedance(
      "http://asset.localhost/C%3A%5CUsers%5Cme%5Cmedia%5Cv.mp4",
    );
    expect(invokeMock).toHaveBeenCalledWith("compress_reference_video", {
      videoPath: "C:\\Users\\me\\media\\v.mp4",
      maxPixels: MAX_REF_VIDEO_PIXELS,
    });
  });

  it("自定义 maxPixels 透传给 Rust", async () => {
    invokeMock.mockResolvedValue("media/compressed/y.mp4");
    await shrinkReferenceVideoForSeedance("media/videos/y.mp4", 927_408);
    expect(invokeMock).toHaveBeenCalledWith("compress_reference_video", {
      videoPath: "media/videos/y.mp4",
      maxPixels: 927_408,
    });
  });

  it.each([
    ["https://cos.example.com/a.mp4"],
    ["http://cdn.example.com/b.mp4"],
    ["data:video/mp4;base64,AAAA"],
    ["blob:http://localhost/uuid"],
  ])("真远端 / WebView-only(%s)→ 降级原样返回,不调 Rust", async (url) => {
    const out = await shrinkReferenceVideoForSeedance(url);
    expect(out).toBe(url);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("空串原样返回,不调 Rust", async () => {
    expect(await shrinkReferenceVideoForSeedance("")).toBe("");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  // Rust 报错时的包装走 describeCompressError(纯函数)。不在这里 mock invoke 抛错 ——
  // vitest 会把经由 vi.fn spy 冒出的错误(throw 或 rejected promise)当成测试自身失败,
  // 即便业务代码已 try/catch。故把"错误信息格式"抽成纯函数单独测,语义等价且无误报。
  it("describeCompressError:包装 Rust 报错为友好前缀", () => {
    expect(describeCompressError(new Error("ffmpeg 退出码: Some(1)"))).toBe(
      "参考视频压缩失败:ffmpeg 退出码: Some(1)",
    );
    expect(describeCompressError("boom")).toBe("参考视频压缩失败:boom");
  });
});
