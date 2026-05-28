/**
 * 启动后台静默查更新 → 有新版就弹这个对话框。
 *
 * 行为约定:
 *   - 进入 AuthenticatedApp 后延迟 2.5s 触发(让首屏先稳下来再弹)
 *   - 网络/服务端任何错误都吞掉 + 落 console,不打扰用户
 *   - 命中"用户跳过过此版本"则只在 console 提一句,不弹
 *   - force_update=true 时不显示"稍后"和"跳过此版本"
 *
 * 非启动场景的"检查更新"在 SettingsDialog → 更新 Tab 里手动触发,
 * 不复用这个对话框。
 */

import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import {
  checkForUpdate,
  installLatestUpdate,
  getSkippedVersion,
  setSkippedVersion,
  type UpdateAvailable,
} from "@/platform/update.api";
import { isTauri } from "@/platform/runtime";
import { useUIStore } from "@/stores/uiStore";

const STARTUP_DELAY_MS = 2500;

export default function UpdateDialog() {
  const addToast = useUIStore((s) => s.addToast);

  const [info, setInfo] = useState<UpdateAvailable | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (!isTauri) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const upd = await checkForUpdate();
        if (cancelled || !upd) return;

        const skipped = getSkippedVersion();
        if (!upd.force_update && skipped === upd.version) {
          console.info(`[UpdateDialog] update v${upd.version} skipped by user, ignored`);
          return;
        }
        setInfo(upd);
      } catch (e) {
        // 静默失败:启动时网络可能没通,不能因为这事弹错给用户。
        console.warn("[UpdateDialog] background check failed:", e);
      }
    }, STARTUP_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (!info) return null;

  async function handleInstall() {
    if (installing) return;
    setInstalling(true);
    try {
      await installLatestUpdate();
      // 正常路径会被 updater 杀进程重启,走不到这里
    } catch (e) {
      addToast({
        type: "error",
        title: "更新失败",
        description: e instanceof Error ? e.message : String(e),
        duration: 6000,
      });
      setInstalling(false);
    }
  }

  function handleSkip() {
    if (info && !info.force_update) {
      setSkippedVersion(info.version);
    }
    setInfo(null);
  }

  function handleLater() {
    // 不写入"跳过版本",下次启动还会弹
    setInfo(null);
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
            <div className="text-base font-semibold">
              发现新版本 v{info.version}
              {info.force_update && (
                <span className="ml-2 rounded bg-destructive/15 px-1.5 py-0.5 text-xs font-medium text-destructive">
                  强制更新
                </span>
              )}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              当前版本 v{info.current_version}
            </div>
          </div>
          {!info.force_update && (
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

        {info.notes && (
          <div className="max-h-64 overflow-y-auto whitespace-pre-wrap border-b border-border px-5 py-4 text-sm text-foreground/90">
            {info.notes}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 p-4">
          {!info.force_update && (
            <button
              type="button"
              onClick={handleSkip}
              disabled={installing}
              className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              跳过此版本
            </button>
          )}
          {!info.force_update && (
            <button
              type="button"
              onClick={handleLater}
              disabled={installing}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
            >
              稍后
            </button>
          )}
          <button
            type="button"
            onClick={handleInstall}
            disabled={installing}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {installing ? "更新中…" : "立即更新"}
          </button>
        </div>
      </div>
    </div>
  );
}
