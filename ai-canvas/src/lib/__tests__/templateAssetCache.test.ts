import { describe, it, expect, vi } from "vitest";

/**
 * 回归:模板参考图泄漏 `http://asset.localhost/...` 的根治(task #2064278348656156673 复盘)。
 *
 * 规约 —— 模板图的**规范 URL 永远是极境公网 URL**(`https://.../aicanvas-static/...`):
 *   - 数据层(模板定义 / 实例化出的卡片 refImages)绝不写本机 asset.localhost 显示地址,
 *     否则送上游被服务端 SSRF 闸以 "asset.localhost -> 127.0.0.1" 拦掉、任务 SUBMIT 失败。
 *   - 送上游(mediaToApiRef):公网 URL 原样直传,零上传、零改写。
 *   - 显示(getDisplayUrl):命中本地缓存就换本机文件(离线 / 秒开),否则透传走网络。
 */

// initMediaService 走 isTauri 门禁 + 动态 import @tauri-apps/api/core;mock 成"已在
// Tauri"并给出 convertFileSrc / invoke,验证显示缓存真把公网 URL 重定向到本机文件。
vi.mock("@/platform/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/runtime")>()),
  isTauri: true,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => (cmd === "get_media_base_path" ? "C:\\base" : undefined),
  convertFileSrc: (p: string) => "http://asset.localhost/" + encodeURIComponent(p),
}));

import { getDisplayUrl, registerTemplateAssetCache, initMediaService } from "@/lib/media";
import { mediaToApiRef } from "@/platform/media";

const PUBLIC_URL =
  "https://www.jjowo.com/aicanvas-static/templates/imported/1e537dc5a0bd88cb.jpg";
const REL = "template-assets/1e537dc5a0bd88cb.jpg";

describe("模板资源 URL 规范化(数据层公网 / 显示层本地缓存)", () => {
  it("送上游:公网模板 URL 经 mediaToApiRef 原样直传,零上传、零改写", async () => {
    await expect(mediaToApiRef(PUBLIC_URL)).resolves.toBe(PUBLIC_URL);
  });

  it("APIs 未就绪时,已注册的公网 URL 仍透传(不产出空 / 坏 src)", () => {
    registerTemplateAssetCache(PUBLIC_URL, REL);
    // initMediaService 尚未跑 → _convertFileSrc=null → 缓存解析返 null → 透传公网 URL
    expect(getDisplayUrl(PUBLIC_URL)).toBe(PUBLIC_URL);
  });

  it("init 后,已注册公网 URL 的 getDisplayUrl 重定向到本机文件(离线 / 秒开)", async () => {
    await initMediaService();
    registerTemplateAssetCache(PUBLIC_URL, REL);
    expect(getDisplayUrl(PUBLIC_URL)).toBe(
      "http://asset.localhost/" +
        encodeURIComponent("C:\\base\\template-assets\\1e537dc5a0bd88cb.jpg"),
    );
  });

  it("未注册的公网 URL → 透传走网络(不误命中缓存)", () => {
    expect(getDisplayUrl("https://example.com/whatever.jpg")).toBe(
      "https://example.com/whatever.jpg",
    );
  });
});
