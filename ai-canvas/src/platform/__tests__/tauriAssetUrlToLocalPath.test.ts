import { describe, it, expect } from "vitest";
import { tauriAssetUrlToLocalPath } from "../media";

/**
 * 回归:Windows `convertFileSrc` 产出的 `http://asset.localhost/...` 显示 URL
 * 曾以 `http://` 开头被 `mediaToApiRef` 误判成「已是远端」直传给上游, 上游 fetch
 * 这个指向本机的 URL → "Error while downloading file. Upstream status code: 502."
 * 该函数把这类 asset 显示 URL 还原成本地绝对路径, 让其改走 upload_to_server 真上传。
 */
describe("tauriAssetUrlToLocalPath", () => {
  it("反解 Windows http://asset.localhost (剥前导 / 还原盘符 + 反斜杠)", () => {
    const url =
      "http://asset.localhost/" +
      encodeURIComponent(
        "C:\\Users\\Administrator\\AppData\\Roaming\\com.ai-canvas.desktop\\media\\images\\x.png",
      );
    expect(tauriAssetUrlToLocalPath(url)).toBe(
      "C:\\Users\\Administrator\\AppData\\Roaming\\com.ai-canvas.desktop\\media\\images\\x.png",
    );
  });

  it("反解配了 https scheme 的 https://asset.localhost", () => {
    const url =
      "https://asset.localhost/" + encodeURIComponent("C:/Users/a/media/images/y.jpg");
    expect(tauriAssetUrlToLocalPath(url)).toBe("C:/Users/a/media/images/y.jpg");
  });

  it("反解 mac/Linux asset://localhost (保留 Unix 绝对路径前导 /)", () => {
    const url =
      "asset://localhost/" + encodeURIComponent("/home/u/.local/share/app/media/z.png");
    expect(tauriAssetUrlToLocalPath(url)).toBe("/home/u/.local/share/app/media/z.png");
  });

  it("真·远端 URL(host ≠ asset.localhost)返回 null —— 仍走原直传快路径", () => {
    expect(
      tauriAssetUrlToLocalPath("https://ai.snoworangekeji.cn/uploads/media/a.png"),
    ).toBeNull();
    expect(tauriAssetUrlToLocalPath("http://example.com/asset.localhost/x")).toBeNull();
  });

  it("非 URL 字符串(相对路径 / local:// / data: / blob:)返回 null", () => {
    expect(tauriAssetUrlToLocalPath("media/images/x.png")).toBeNull();
    expect(tauriAssetUrlToLocalPath("local://media/images/x.png")).toBeNull();
    expect(tauriAssetUrlToLocalPath("data:image/png;base64,AAAA")).toBeNull();
    expect(tauriAssetUrlToLocalPath("blob:abcd-1234")).toBeNull();
    expect(tauriAssetUrlToLocalPath("")).toBeNull();
  });
});
