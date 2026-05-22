import { Image, Video, Music, AlertTriangle, MapPin, RefreshCw } from "lucide-react";
import type { AsyncTask } from "@/types";
import { ACTIVE_STATUSES } from "@/types";
import { getDisplayUrl } from "@/lib/media";
import { cn } from "@/lib/utils";

interface Props {
  task: AsyncTask;
  projectName?: string;
  onLocate: (cardId: string) => void;
  onRetry: (taskId: string) => void;
}

const STATUS_CFG: Record<string, { label: string; color: string; dot: string }> = {
  queued:     { label: "排队中", color: "text-blue-500",           dot: "bg-blue-500" },
  submitting: { label: "提交中", color: "text-blue-500",           dot: "bg-blue-500" },
  polling:    { label: "生成中", color: "text-blue-500",           dot: "bg-blue-500" },
  success:    { label: "成功",   color: "text-emerald-500",        dot: "bg-emerald-500" },
  failed:     { label: "失败",   color: "text-red-500",            dot: "bg-red-500" },
  canceled:   { label: "已取消", color: "text-muted-foreground",   dot: "bg-muted-foreground" },
  orphaned:   { label: "已废弃", color: "text-muted-foreground",   dot: "bg-muted-foreground" },
};

const KIND_CFG: Record<string, { icon: typeof Image; label: string }> = {
  image_gen: { icon: Image, label: "图片" },
  video_gen: { icon: Video, label: "视频" },
  audio_gen: { icon: Music, label: "音频" },
};

function relativeTime(iso: string): string {
  const d = new Date(iso + (iso.endsWith("Z") ? "" : "Z"));
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 60_000) return "刚刚";
  const min = Math.floor(diffMs / 60_000);
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  const day = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86_400_000,
  );
  if (day === 1) return "昨天";
  return `${day}天前`;
}

function getPrompt(task: AsyncTask): string {
  const p = (task.request as Record<string, unknown>)?.prompt;
  return typeof p === "string" ? p : "";
}

function getResultDisplayUrl(task: AsyncTask): string {
  if (task.status !== "success" || !task.result) return "";
  const url = (task.result as Record<string, unknown>).url;
  return typeof url === "string" ? getDisplayUrl(url) : "";
}

function formatElapsed(task: AsyncTask): string | null {
  if (ACTIVE_STATUSES.has(task.status)) return null;
  const start = new Date(task.createdAt + (task.createdAt.endsWith("Z") ? "" : "Z"));
  const end = new Date(task.updatedAt + (task.updatedAt.endsWith("Z") ? "" : "Z"));
  const sec = Math.max(0, (end.getTime() - start.getTime()) / 1000);
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${Math.floor(sec / 60)}m${Math.round(sec % 60)}s`;
}

export default function TaskRecordCard({ task, projectName, onLocate, onRetry }: Props) {
  const isActive = ACTIVE_STATUSES.has(task.status);
  const isFailed = task.status === "failed";
  const isSuccess = task.status === "success";

  const st = (STATUS_CFG[task.status] ?? STATUS_CFG.failed)!;
  const kc = (KIND_CFG[task.kind] ?? KIND_CFG.image_gen)!;
  const KindIcon = kc.icon;
  const prompt = getPrompt(task);
  const thumbUrl = isSuccess ? getResultDisplayUrl(task) : "";
  const elapsed = formatElapsed(task);
  const isVideo = task.kind === "video_gen";

  return (
    <div className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-shadow hover:shadow-md">
      {/* Thumbnail / placeholder */}
      <div className={cn(
        "relative flex aspect-[4/3] items-center justify-center overflow-hidden",
        isSuccess && thumbUrl ? "" : "bg-muted/50",
      )}>
        {isSuccess && thumbUrl ? (
          <>
            {isVideo ? (
              <video src={thumbUrl} className="h-full w-full object-cover" muted preload="none" />
            ) : (
              <img src={thumbUrl} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
            )}
            {isVideo && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current"><polygon points="8,5 19,12 8,19" /></svg>
                </div>
              </div>
            )}
          </>
        ) : isActive ? (
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <KindIcon className="h-8 w-8 animate-pulse" />
            <span className="text-xs">生成中...</span>
          </div>
        ) : isFailed ? (
          <div className="flex flex-col items-center gap-2 text-red-400">
            <AlertTriangle className="h-8 w-8" />
            <span className="text-xs">生成失败</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-muted-foreground/60">
            <KindIcon className="h-8 w-8" />
            <span className="text-xs">已取消</span>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex flex-1 flex-col gap-1.5 p-2.5">
        {/* Type · provider · status */}
        <div className="flex items-center justify-between gap-1">
          <div className="flex items-center gap-1 truncate text-xs text-muted-foreground">
            <KindIcon className="h-3 w-3 shrink-0" />
            <span>{kc.label}</span>
            <span className="text-muted-foreground/50">·</span>
            <span className="truncate">{task.provider}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", st.dot, isActive && "animate-pulse")} />
            <span className={cn("text-xs font-medium", st.color)}>{st.label}</span>
          </div>
        </div>

        {/* Prompt */}
        {prompt && (
          <p className="line-clamp-2 text-xs leading-relaxed text-foreground/80">{prompt}</p>
        )}

        {/* Progress bar */}
        {isActive && (
          <div className="flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-blue-500 transition-all duration-300"
                style={{ width: `${Math.min(100, task.progress)}%` }}
              />
            </div>
            <span className="text-[10px] tabular-nums text-muted-foreground">{Math.round(task.progress)}%</span>
          </div>
        )}

        {/* Error */}
        {isFailed && task.errorMessage && (
          <p className="line-clamp-1 text-[10px] text-red-400">
            {task.errorMessage.replace(/^\[transient\]\s*/, "")}
          </p>
        )}

        {/* Meta */}
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          {projectName && (
            <>
              <span className="max-w-[60px] truncate">{projectName}</span>
              <span className="text-muted-foreground/40">·</span>
            </>
          )}
          <span className="shrink-0">{relativeTime(task.createdAt)}</span>
          {elapsed && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className="shrink-0">{elapsed}</span>
            </>
          )}
        </div>

        {/* Actions — hover reveal */}
        <div className="flex items-center justify-end gap-1 pt-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {!isActive && (
            <button
              onClick={() => onLocate(task.cardId)}
              className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <MapPin className="h-2.5 w-2.5" /> 定位
            </button>
          )}
          {(isFailed || isSuccess || task.status === "canceled") && (
            <button
              onClick={() => onRetry(task.id)}
              className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] text-blue-500 transition-colors hover:bg-blue-500/10"
            >
              <RefreshCw className="h-2.5 w-2.5" /> {isFailed ? "重试" : "重新生成"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
