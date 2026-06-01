/**
 * 启动后台静默查 ffmpeg → 本地缺则弹框让用户决定要不要立即下载。
 *
 * 行为约定:
 *   - 进入 AuthenticatedApp 后延迟 2.5s 触发(跟 UpdateDialog 同节奏,
 *     避免首屏跟一堆别的初始化抢资源)
 *   - 本地命中(exe 同级 / data_dir 缓存 / 系统 PATH brew/winget)→ 不弹
 *   - 当前平台无 bundle(Win arm / Linux)→ 不弹,只 console.warn
 *   - 任何 invoke 失败都吞掉 + console.warn,不打扰用户
 *   - 用户拒绝下载也不报错;真到点关键帧时 ensure_ffmpeg 仍会 lazy 兜底下载
 *
 * 跟 UpdateDialog 是平行关系: UpdateDialog 管新版本提醒, 这个管 ffmpeg 依赖
 * 提醒, 互不影响。两个都在 App.tsx mount。
 */

import { useEffect, useRef, useState } from "react";
import { Download, X } from "lucide-react";
import {
  checkFfmpegStatus,
  downloadFfmpeg,
  type FfmpegStatus,
} from "@/platform/ffmpeg.api";
import { isTauri } from "@/platform/runtime";
import { useUIStore } from "@/stores/uiStore";

const STARTUP_DELAY_MS = 2500;

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export default function FfmpegSetupDialog() {
  const addToast = useUIStore((s) => s.addToast);

  // 只保留 missing 状态需要弹框;ready / unsupported 直接不渲染
  const [missing, setMissing] = useState<
    Extract<FfmpegStatus, { kind: "missing" }> | null
  >(null);
  const [downloading, setDownloading] = useState(false);
  const [received, setReceived] = useState(0);

  // 防止 React strict mode 双 mount 时同时跑两次 check
  const checkedRef = useRef(false);

  useEffect(() => {
    if (!isTauri || checkedRef.current) return;
    checkedRef.current = true;

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const status = await checkFfmpegStatus();
        if (cancelled) return;
        if (status.kind === "missing") {
          setMissing(status);
        } else if (status.kind === "unsupported") {
          console.warn(
            `[FfmpegSetupDialog] 当前平台 (${status.os}/${status.arch}) 暂无 ffmpeg bundle;` +
              ` 视频帧抽取功能需要用户手动安装 ffmpeg 到系统 PATH`,
          );
        }
        // ready: silent
      } catch (e) {
        // 启动时网络偶发 / Tauri 命令未注册 / 其它异常都不能弹错给用户
        console.warn("[FfmpegSetupDialog] background check failed:", e);
      }
    }, STARTUP_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (!missing) return null;

  const total = missing.size_bytes;
  const pct = total > 0 ? Math.min(100, (received / total) * 100) : 0;

  async function handleDownload() {
    if (downloading) return;
    setDownloading(true);
    setReceived(0);
    try {
      await downloadFfmpeg((p) => setReceived(p.received));
      addToast({
        type: "success",
        title: "ffmpeg 已就绪",
        description: "智能关键帧等功能现在可用",
        duration: 4000,
      });
      setMissing(null);
    } catch (e) {
      addToast({
        type: "error",
        title: "ffmpeg 下载失败",
        description: e instanceof Error ? e.message : String(e),
        duration: 8000,
      });
      setDownloading(false);
    }
  }

  function handleLater() {
    if (downloading) return;
    setMissing(null);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        className="w-full max-w-md rounded-lg border border-border bg-card text-card-foreground shadow-xl"
      >
        <div className="flex items-start gap-3 border-b border-border p-5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <Download className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold">需要安装 ffmpeg</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              智能关键帧 / 视频抽帧功能需要,大小约 {formatBytes(total)}
            </div>
          </div>
          {!downloading && (
            <button
              type="button"
              onClick={handleLater}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="space-y-3 border-b border-border px-5 py-4 text-sm text-foreground/90">
          <p>
            未检测到 ffmpeg。下载约 {formatBytes(total)},完成后无需再次下载。
          </p>
          {downloading && (
            <div className="space-y-1.5">
              <div className="h-2 overflow-hidden rounded bg-muted">
                <div
                  className="h-full bg-primary transition-[width] duration-150"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>
                  {formatBytes(received)} / {formatBytes(total)}
                </span>
                <span>{pct.toFixed(1)}%</span>
              </div>
            </div>
          )}
          {!downloading && (
            <p className="text-xs text-muted-foreground">
              选"以后再说"也可以 —— 真用到关键帧功能时会自动开始下载,
              只是那时会等一会儿。
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4">
          {!downloading && (
            <button
              type="button"
              onClick={handleLater}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
            >
              以后再说
            </button>
          )}
          <button
            type="button"
            onClick={handleDownload}
            disabled={downloading}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {downloading ? "下载中…" : "现在下载"}
          </button>
        </div>
      </div>
    </div>
  );
}
