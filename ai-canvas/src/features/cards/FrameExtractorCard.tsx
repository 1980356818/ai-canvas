import { memo, useCallback, useMemo } from "react";
import { Loader2, Scissors, AlertTriangle, CheckCircle2, Film } from "lucide-react";
import {
  parseShotsFromText,
  resolveVideoUrl,
  runFrameExtraction,
  type FrameExtractorData,
} from "@/lib/frameExtraction";
import type { CanvasCard } from "@/types";

type StatusTone = "neutral" | "ok" | "warn" | "error";

interface StatusView {
  icon: React.ReactNode;
  label: string;
  tone: StatusTone;
}

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: "text-muted-foreground",
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
};

/** 把 (card.data, parsed, videoUrl) 翻译成一个状态行展示。 */
function computeStatusView(
  data: FrameExtractorData,
  shotsCount: number,
  hasVideo: boolean,
): StatusView {
  const extractedCount = data.extractedFrames?.length ?? 0;
  const status = data.status ?? "idle";

  if (status === "running") {
    return {
      icon: <Loader2 className="h-4 w-4 animate-spin" />,
      label: `正在提取 ${shotsCount} 帧…`,
      tone: "neutral",
    };
  }
  if (status === "error") {
    return {
      icon: <AlertTriangle className="h-4 w-4" />,
      label: data.errorMessage || "提取失败",
      tone: "error",
    };
  }
  if (status === "done" && extractedCount > 0) {
    return {
      icon: <CheckCircle2 className="h-4 w-4" />,
      label: `已提取 ${extractedCount} 帧`,
      tone: "ok",
    };
  }
  if (shotsCount === 0) {
    return {
      icon: <Film className="h-4 w-4" />,
      label: "等待上游分镜数据",
      tone: "neutral",
    };
  }
  if (!hasVideo) {
    return {
      icon: <AlertTriangle className="h-4 w-4" />,
      label: "未找到视频源",
      tone: "warn",
    };
  }
  return {
    icon: <Film className="h-4 w-4" />,
    label: `${shotsCount} 帧待提取`,
    tone: "ok",
  };
}

export default memo(function FrameExtractorCard({ card }: { card: CanvasCard }) {
  const data = card.data as FrameExtractorData;

  const parsed = useMemo(
    () => parseShotsFromText(data.upstreamChatResult),
    [data.upstreamChatResult],
  );
  const videoUrl = resolveVideoUrl(data);

  const shotsCount = parsed?.shots.length ?? 0;
  const isRunning = data.status === "running";
  const ready = shotsCount > 0 && !!videoUrl && !isRunning;
  const hasExtracted = (data.extractedFrames?.length ?? 0) > 0;

  const statusView = computeStatusView(data, shotsCount, !!videoUrl);

  const handleExtract = useCallback(() => {
    void runFrameExtraction(card.id);
  }, [card.id]);

  const stopDrag = useCallback((e: React.PointerEvent | React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="flex items-center gap-2 text-xs font-semibold">
        <Scissors className="h-4 w-4 text-emerald-500" />
        关键帧提取器
      </div>

      <div className={`flex items-center gap-1.5 text-[11px] leading-tight ${TONE_CLASS[statusView.tone]}`}>
        {statusView.icon}
        <span className="truncate" title={statusView.label}>
          {statusView.label}
        </span>
      </div>

      {parsed && (
        <div className="text-[10px] text-muted-foreground/70 leading-relaxed line-clamp-3">
          {parsed.summary ?? `共 ${shotsCount} 个镜头`}
        </div>
      )}

      <div className="mt-auto">
        <button
          type="button"
          onClick={handleExtract}
          onPointerDown={stopDrag}
          disabled={!ready}
          className="w-full rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
        >
          {hasExtracted ? "重新提取关键帧" : "提取关键帧"}
        </button>
      </div>
    </div>
  );
});
