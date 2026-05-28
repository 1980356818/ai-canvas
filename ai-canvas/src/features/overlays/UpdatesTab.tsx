/**
 * 设置 → 更新 Tab。两件事:
 *   1. "检查更新"按钮:走 Tauri updater 看有没有更高版本
 *   2. "可用版本列表":从服务端拉 /api/update/list/{target}/{arch},
 *      展示所有 is_active=1 的版本。停用的不会出现 = 不能切。
 *      点"切换到此版本"会调 switch_to_version Tauri 命令,允许降级。
 *
 * 当前运行版本会有徽章标记;切换时弹确认框,确认后下载安装 + 重启。
 */

import { useEffect, useState } from "react";
import { CheckCircle2, Download, Loader2, RefreshCw } from "lucide-react";
import {
  apiListAvailableVersions,
  checkForUpdate,
  getRuntimeInfo,
  installLatestUpdate,
  switchToVersion,
  type RuntimeInfo,
  type UpdateAvailable,
  type VersionItem,
} from "@/platform/update.api";
import { ConfirmDialog } from "./ConfirmDialog";
import { useUIStore } from "@/stores/uiStore";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatPubDate(iso: string | null): string {
  if (!iso) return "";
  // 后端返回 LocalDateTime.toString() = "2026-05-29T13:24:56" 或 RFC3339
  try {
    const d = new Date(iso.includes("Z") ? iso : iso + "Z");
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export default function UpdatesTab() {
  const addToast = useUIStore((s) => s.addToast);

  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [checking, setChecking] = useState(false);
  const [latestUpdate, setLatestUpdate] = useState<UpdateAvailable | null>(null);
  const [confirmSwitch, setConfirmSwitch] = useState<VersionItem | null>(null);
  const [busy, setBusy] = useState(false);

  // ── 初始化 ────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      try {
        const rt = await getRuntimeInfo();
        setRuntime(rt);
        await loadVersions(rt);
      } catch (e) {
        console.error("[UpdatesTab] init failed:", e);
      }
    })();
    // 仅初次挂载,后续手动"刷新"
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadVersions(rt: RuntimeInfo) {
    setLoadingList(true);
    try {
      const list = await apiListAvailableVersions(rt.target, rt.arch);
      setVersions(list);
    } catch (e) {
      addToast({
        type: "error",
        title: "拉取版本列表失败",
        description: e instanceof Error ? e.message : String(e),
        duration: 5000,
      });
    } finally {
      setLoadingList(false);
    }
  }

  async function handleCheckUpdate() {
    setChecking(true);
    setLatestUpdate(null);
    try {
      const upd = await checkForUpdate();
      if (upd) {
        setLatestUpdate(upd);
      } else {
        addToast({
          type: "success",
          title: "已是最新版本",
          description: `当前 ${runtime?.version ?? ""}`,
          duration: 3000,
        });
      }
      if (runtime) await loadVersions(runtime);
    } catch (e) {
      addToast({
        type: "error",
        title: "检查更新失败",
        description: e instanceof Error ? e.message : String(e),
        duration: 5000,
      });
    } finally {
      setChecking(false);
    }
  }

  async function handleInstallLatest() {
    if (busy) return;
    setBusy(true);
    try {
      await installLatestUpdate();
      // 正常情况下进程会被 updater 杀掉重启,到不了这一行
    } catch (e) {
      addToast({
        type: "error",
        title: "更新失败",
        description: e instanceof Error ? e.message : String(e),
        duration: 5000,
      });
      setBusy(false);
    }
  }

  async function handleSwitch(v: VersionItem) {
    if (busy) return;
    setConfirmSwitch(null);
    setBusy(true);
    try {
      await switchToVersion(v.id);
    } catch (e) {
      addToast({
        type: "error",
        title: `切换到 ${v.version} 失败`,
        description: e instanceof Error ? e.message : String(e),
        duration: 5000,
      });
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* 当前版本 + 检查更新 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              当前版本
            </div>
            <div className="mt-1 font-mono text-lg font-semibold">
              {runtime?.version ?? "..."}
              {runtime && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {runtime.target}/{runtime.arch}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            disabled={checking || busy}
            onClick={handleCheckUpdate}
            className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            {checking ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            检查更新
          </button>
        </div>

        {latestUpdate && (
          <div className="mt-3 rounded-md border border-primary/30 bg-primary/5 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">
                  发现新版本: {latestUpdate.version}
                  {latestUpdate.force_update && (
                    <span className="ml-2 rounded bg-destructive/15 px-1.5 py-0.5 text-xs font-medium text-destructive">
                      强制更新
                    </span>
                  )}
                </div>
                {latestUpdate.notes && (
                  <div className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">
                    {latestUpdate.notes}
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={handleInstallLatest}
                className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {busy ? "更新中..." : "立即更新"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 可用版本列表 */}
      <div className="rounded-lg border border-border">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <div className="text-sm font-semibold">可用版本</div>
            <div className="text-xs text-muted-foreground">
              已停用的版本不会出现在这里
            </div>
          </div>
          <button
            type="button"
            disabled={loadingList || !runtime}
            onClick={() => runtime && loadVersions(runtime)}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            title="刷新"
          >
            {loadingList ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </button>
        </div>

        {versions.length === 0 && !loadingList && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            服务端暂无可用版本
          </div>
        )}

        <ul className="divide-y divide-border">
          {versions.map((v) => {
            const isCurrent = runtime?.version === v.version;
            return (
              <li key={v.id} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold">
                      v{v.version}
                    </span>
                    {isCurrent && (
                      <span className="flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="h-3 w-3" />
                        当前
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {formatSize(v.fileSize)} · {formatPubDate(v.pubDate)}
                    </span>
                  </div>
                  {v.releaseNotes && (
                    <div className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
                      {v.releaseNotes}
                    </div>
                  )}
                </div>
                {!isCurrent && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmSwitch(v)}
                    className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
                  >
                    <Download className="h-3.5 w-3.5" />
                    切换到此版本
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <ConfirmDialog
        open={confirmSwitch !== null}
        title={`切换到 v${confirmSwitch?.version ?? ""}?`}
        description={
          confirmSwitch
            ? `当前 v${runtime?.version ?? "?"} → v${confirmSwitch.version}\n应用会下载、校验签名、安装后自动重启。${
                runtime &&
                confirmSwitch.versionCode <
                  encodeVersion(runtime.version)
                  ? "\n⚠ 这是降级,可能存在数据库不兼容风险。"
                  : ""
              }`
            : ""
        }
        confirmLabel="切换"
        onConfirm={() => confirmSwitch && handleSwitch(confirmSwitch)}
        onCancel={() => setConfirmSwitch(null)}
      />
    </div>
  );
}

// 跟服务端 encodeVersion 一致的简化版,只用来判断"是不是降级"。
function encodeVersion(v: string): number {
  const head = v.split(/[-+]/)[0] ?? "";
  const parts = head.split(".");
  const major = parseInt(parts[0] || "0", 10) || 0;
  const minor = parseInt(parts[1] || "0", 10) || 0;
  const patch = parseInt(parts[2] || "0", 10) || 0;
  return major * 1_000_000 + minor * 1_000 + patch;
}
