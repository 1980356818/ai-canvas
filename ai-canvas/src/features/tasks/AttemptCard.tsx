import { useState } from "react";
import { AlertTriangle, Download, Loader2, MapPin, RefreshCw } from "lucide-react";
import type { AsyncTask } from "@/types";
import { ACTIVE_STATUSES } from "@/types";
import { cn } from "@/lib/utils";
import { exportFile } from "@/lib/media";
import { saveMedia } from "@/platform";
import { useUIStore } from "@/stores/uiStore";
import {
  STATUS_CFG,
  KIND_CFG,
  relativeTime,
  getPrompt,
  getResultUrl,
  getResultDisplayUrl,
  formatElapsed,
} from "./taskPresentation";

interface Props {
  task: AsyncTask;
  /** 是否为该卡当前尝试(supersededAt 为空)。当前尝试加一个高亮边。 */
  isCurrent: boolean;
  onLocate: (cardId: string) => void;
  onRetry: (taskId: string) => void;
}

export default function AttemptCard({ task, isCurrent, onLocate, onRetry }: Props) {
  const [saving, setSaving] = useState(false);

  const isActive = ACTIVE_STATUSES.has(task.status);
  const isSuccess = task.status === "success";
  const isFailed = task.status === "failed";
  const st = (STATUS_CFG[task.status] ?? STATUS_CFG.failed)!;
  const kc = (KIND_CFG[task.kind] ?? KIND_CFG.image_gen)!;
  const KindIcon = kc.icon;
  const isVideo = task.kind === "video_gen";
  const prompt = getPrompt(task);
  const thumbUrl = getResultDisplayUrl(task);
  const elapsed = formatElapsed(task);
  const canSave = isSuccess && !!getResultUrl(task);

  const handleSave = async () => {
    const raw = getResultUrl(task);
    if (!raw || saving) return;
    const title = prompt || (isVideo ? "AI视频" : "AI图片");
    setSaving(true);
    try {
      // result.url 正常是本地 storagePath(finalize 已下载);若 finalize 失败仍是远端,
      // 先 saveMedia 拉到本地再导出。两者都复用现成能力,不回写画布、不重新计费。
      let storedPath = raw;
      if (/^(https?:|data:)/i.test(raw)) {
        const saved = await saveMedia(raw, undefined, title, task.projectId);
        storedPath = saved.localPath;
      }
      await exportFile(storedPath, title, task.projectId);
      useUIStore.getState().addToast({
        type: "success",
        title: isVideo ? "视频已保存到本地" : "图片已保存到本地",
        duration: 2500,
      });
    } catch (err) {
      useUIStore.getState().addToast({
        type: "error",
        title: "保存失败",
        description: String(err),
        duration: 4000,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={cn(
        "group flex gap-2.5 rounded-lg border p-2 transition-shadow hover:shadow-sm",
        isCurrent ? "border-primary/60 bg-primary/5" : "border-border bg-card",
      )}
    >
      {/* 缩略图 */}
      <div className="relative flex h-[54px] w-[72px] shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/50">
        {isSuccess && thumbUrl ? (
          isVideo ? (
            <video src={thumbUrl} className="h-full w-full object-cover" muted preload="none" />
          ) : (
            <img src={thumbUrl} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
          )
        ) : isActive ? (
          <KindIcon className="h-5 w-5 animate-pulse text-muted-foreground" />
        ) : isFailed ? (
          <AlertTriangle className="h-5 w-5 text-red-400" />
        ) : (
          <KindIcon className="h-5 w-5 text-muted-foreground/50" />
        )}
      </div>

      {/* 信息 */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs">
            <span className="font-medium text-foreground">尝试 #{task.attemptNo}</span>
            {isCurrent && (
              <span className="rounded bg-primary/15 px-1 py-px text-[10px] text-primary">当前</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", st.dot, isActive && "animate-pulse")} />
            <span className={cn("text-[11px] font-medium", st.color)}>{st.label}</span>
          </div>
        </div>

        {prompt && (
          <p className="line-clamp-1 text-[11px] leading-snug text-muted-foreground">{prompt}</p>
        )}

        {/* 进度条(活跃)或错误(失败) */}
        {isActive ? (
          <div className="flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-blue-500 transition-all duration-300"
                style={{ width: `${Math.min(100, task.progress)}%` }}
              />
            </div>
            <span className="text-[10px] tabular-nums text-muted-foreground">{Math.round(task.progress)}%</span>
          </div>
        ) : isFailed && task.errorMessage ? (
          <p className="line-clamp-1 text-[10px] text-red-400">
            {task.errorMessage.replace(/^\[transient\]\s*/, "")}
          </p>
        ) : null}

        {/* 元信息 + 操作 */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className="shrink-0">{relativeTime(task.createdAt)}</span>
            {elapsed && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="shrink-0">{elapsed}</span>
              </>
            )}
          </div>

          <div className="flex items-center gap-1">
            {canSave && (
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] text-emerald-600 transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Download className="h-2.5 w-2.5" />}
                保存
              </button>
            )}
            {!isActive && (
              <button
                onClick={() => onLocate(task.cardId)}
                className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <MapPin className="h-2.5 w-2.5" /> 定位
              </button>
            )}
            {(isFailed || task.status === "canceled") && (
              <button
                onClick={() => onRetry(task.id)}
                className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] text-blue-500 transition-colors hover:bg-blue-500/10"
              >
                <RefreshCw className="h-2.5 w-2.5" /> 重试
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
