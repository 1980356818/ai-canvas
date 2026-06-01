/**
 * ffmpeg 启动检查 + 主动下载的前端 API 包装。
 *
 * 后端两个 Tauri 命令(见 `src-tauri/src/commands/frame_extract.rs`):
 *   - `check_ffmpeg_status` 同步本地探测,不发网络请求
 *   - `download_ffmpeg` 真下载,边下边 emit `ffmpeg:download_progress`
 *
 * 调用方:`FfmpegSetupDialog` 在 App mount 后 ~2.5s 触发一次 check;
 * 命中 Missing 弹框,用户同意才走 download_ffmpeg。
 *
 * 拒绝下载也不报错 —— 进 app 后真到点关键帧时 `ensure_ffmpeg`(Rust 侧
 * lazy 兜底)会再触发一次下载(无进度),作为 fallback。
 */

import { ensureTauriAPIs, getInvoke, getListen } from "./runtime";

export type FfmpegStatus =
  | { kind: "ready"; source: string }
  | {
      kind: "missing";
      url: string;
      size_bytes: number;
      version: string;
      triple: string;
    }
  | { kind: "unsupported"; os: string; arch: string };

export interface FfmpegProgress {
  received: number;
  total: number;
}

export async function checkFfmpegStatus(): Promise<FfmpegStatus> {
  await ensureTauriAPIs();
  return getInvoke()<FfmpegStatus>("check_ffmpeg_status");
}

/**
 * 启动真下载。`onProgress` 可选,提供则订阅 `ffmpeg:download_progress` 事件。
 * Promise 在文件落地 + SHA 校验通过 + 真 spawn `-version` 兜底通过后 resolve。
 */
export async function downloadFfmpeg(
  onProgress?: (p: FfmpegProgress) => void,
): Promise<void> {
  await ensureTauriAPIs();

  let unlisten: (() => void) | null = null;
  if (onProgress) {
    unlisten = await getListen()<FfmpegProgress>(
      "ffmpeg:download_progress",
      (e) => onProgress(e.payload),
    );
  }

  try {
    await getInvoke()<void>("download_ffmpeg");
  } finally {
    try {
      unlisten?.();
    } catch {
      // unlisten 失败不影响下载结果,吞掉
    }
  }
}
