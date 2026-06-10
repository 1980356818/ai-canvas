//! Seedance 2.0 参考生视频(r2v)参考视频像素压缩 —— 提交前把过大的参考视频
//! 等比缩到上游单帧像素上限以下,「不过度压缩」(已达标原样放行)。
//!
//! 背景与设计:docs/r2v参考视频像素压缩-设计与施工图.md
//! 根因:上游对火山 doubao-seedance-2-0 r2v 参考视频限制单帧 W×H ≤ 2,086,876,
//! 用户素材(手机直拍 / 2K / 4K)超了被拒(报错 content[N] video pixel count)。
//!
//! 落点:buildVideoRequest 在上传 refVideos 前,对 Seedance r2v 族逐条调用本模块。
//! 实际探尺寸 + 缩放在 Rust(ffmpeg,命令 `compress_reference_video`),前端只做
//! 路径归一(asset.localhost 显示 URL → 绝对路径)+ 远端/非本地降级。

import { tauriAssetUrlToLocalPath } from "@/platform/media";
import { isTauri } from "@/platform/runtime";

/**
 * Seedance r2v 参考视频单帧像素上限(本仓唯一真源 / SSOT)。
 *
 * 硬上限 2,086,876(API 报错 doubao-seedance-2-0 in r2v),取 1080p 等效
 * (1920×1080 = 2,073,600)留 ~0.6% 余量,吸收上游对偶数/倍数的再取整。
 * 未来某 SKU 若回退到文档的 720p 档(834×1112 = 927,408),改这一处即可。
 */
export const MAX_REF_VIDEO_PIXELS = 2_073_600;

/** 统一包装 Rust 压缩命令的错误信息(导出供测试:纯函数,无副作用)。 */
export function describeCompressError(err: unknown): string {
  return `参考视频压缩失败:${err instanceof Error ? err.message : String(err)}`;
}

/**
 * 若参考视频超像素预算则等比缩并返回新本地路径;已达标 / 远端 / 非本地 → 原样返回。
 *
 * 错误策略:只有「Rust 判定需压缩但编码失败」才 throw(让上层呈现原因,与
 * buildVideoRequest「上传失败直接 throw」的契约一致);「无需压 / 远端 / 探尺寸失败」
 * 一律静默原样返回,绝不因压缩环节挡住生成。
 *
 * @param url       refVideos[].url:`local://` / `media/` / 绝对路径 /
 *                  `http://asset.localhost/...`(Win 显示 URL)/ 真远端 / data:/blob:
 * @param maxPixels 像素预算,默认 {@link MAX_REF_VIDEO_PIXELS}
 * @returns         可被 mediaToApiRef 消费的引用(压缩后的相对路径或原样 url)
 */
export async function shrinkReferenceVideoForSeedance(
  url: string,
  maxPixels: number = MAX_REF_VIDEO_PIXELS,
): Promise<string> {
  if (!url) return url;
  // 纯 Web(无 Tauri)无本地 ffmpeg,跳过 —— 这类环境素材本就是远端 URL。
  if (!isTauri) return url;

  // 1. Windows/Android 的 `convertFileSrc` 显示 URL(http://asset.localhost/<enc-abs>)
  //    先反解回绝对路径(Rust 能读);非 asset 的真远端/相对路径返 null,原样用 url。
  const candidate = tauriAssetUrlToLocalPath(url) ?? url;

  // 2. 真远端 / WebView-only:Rust 命令读不到本地文件,本期降级原样透传。
  //    (远端视频留待后续「下载后再压」迭代;data:/blob: 视频极罕见。)
  if (
    candidate.startsWith("http://") ||
    candidate.startsWith("https://") ||
    candidate.startsWith("data:") ||
    candidate.startsWith("blob:")
  ) {
    return url;
  }

  // 3. 本地路径 → 交给 Rust 探尺寸 + 按需缩放(已达标会原样返回入参路径)。
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<string>("compress_reference_video", {
      videoPath: candidate,
      maxPixels,
    });
  } catch (err) {
    throw new Error(describeCompressError(err));
  }
}
