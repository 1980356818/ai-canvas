/**
 * 任务卡片展示逻辑的共享真相源。
 *
 * TaskRecordCard(全局任务记录网格)与 AttemptCard(每卡任务面板的单行)共用同一份
 * 状态配色 / 缩略图 URL / 相对时间 / 耗时 计算,避免两处漂移。
 */
import { Image, Video, Music } from "lucide-react";
import type { AsyncTask } from "@/types";
import { ACTIVE_STATUSES } from "@/types";
import { getDisplayUrl } from "@/lib/media";

export const STATUS_CFG: Record<
  string,
  { label: string; color: string; dot: string }
> = {
  queued:     { label: "排队中", color: "text-blue-500",         dot: "bg-blue-500" },
  submitting: { label: "提交中", color: "text-blue-500",         dot: "bg-blue-500" },
  polling:    { label: "生成中", color: "text-blue-500",         dot: "bg-blue-500" },
  success:    { label: "成功",   color: "text-emerald-500",      dot: "bg-emerald-500" },
  failed:     { label: "失败",   color: "text-red-500",          dot: "bg-red-500" },
  canceled:   { label: "已取消", color: "text-muted-foreground", dot: "bg-muted-foreground" },
  orphaned:   { label: "已废弃", color: "text-muted-foreground", dot: "bg-muted-foreground" },
};

export const KIND_CFG: Record<string, { icon: typeof Image; label: string }> = {
  image_gen: { icon: Image, label: "图片" },
  video_gen: { icon: Video, label: "视频" },
  audio_gen: { icon: Music, label: "音频" },
};

export function relativeTime(iso: string): string {
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

export function getPrompt(task: AsyncTask): string {
  const p = (task.request as Record<string, unknown>)?.prompt;
  return typeof p === "string" ? p : "";
}

/** 成功任务的结果原始存储地址(可能是本地 storagePath,也可能是远端 http)。供存图用。 */
export function getResultUrl(task: AsyncTask): string | undefined {
  if (task.status !== "success" || !task.result) return undefined;
  const url = (task.result as Record<string, unknown>).url;
  return typeof url === "string" && url ? url : undefined;
}

/** 成功任务的可显示缩略图 URL(经 getDisplayUrl 转 asset:// / 直通远端)。 */
export function getResultDisplayUrl(task: AsyncTask): string {
  const url = getResultUrl(task);
  return url ? getDisplayUrl(url) : "";
}

/** 终态任务的耗时(createdAt→updatedAt)。活跃任务返回 null(用实时计时器)。 */
export function formatElapsed(task: AsyncTask): string | null {
  if (ACTIVE_STATUSES.has(task.status)) return null;
  const start = new Date(task.createdAt + (task.createdAt.endsWith("Z") ? "" : "Z"));
  const end = new Date(task.updatedAt + (task.updatedAt.endsWith("Z") ? "" : "Z"));
  const sec = Math.max(0, (end.getTime() - start.getTime()) / 1000);
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${Math.floor(sec / 60)}m${Math.round(sec % 60)}s`;
}
