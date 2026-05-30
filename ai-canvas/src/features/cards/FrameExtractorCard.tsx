import { memo, useCallback, useMemo } from "react";
import {
  Loader2,
  Scissors,
  AlertTriangle,
  CheckCircle2,
  Film,
  Eye,
  RefreshCw,
} from "lucide-react";
import {
  parseShotsFromText,
  resolveVideoUrl,
  runFrameExtraction,
  type FrameExtractorData,
} from "@/lib/frameExtraction";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard } from "@/types";
import { cn } from "@/lib/utils";

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

/** 状态行翻译。 */
function computeStatusView(
  data: FrameExtractorData,
  shotsCount: number,
  hasVideo: boolean,
  compositeAlive: boolean,
): StatusView {
  const status = data.status ?? "idle";

  if (status === "running") {
    return {
      icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
      label: `正在合成 ${shotsCount} 帧…`,
      tone: "neutral",
    };
  }
  if (status === "error") {
    return {
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
      label: data.errorMessage || "提取失败",
      tone: "error",
    };
  }
  if (status === "done" && compositeAlive) {
    return {
      icon: <CheckCircle2 className="h-3.5 w-3.5" />,
      label: `已合成 ${data.lastFrameCount ?? "?"} 张关键帧`,
      tone: "ok",
    };
  }
  if (shotsCount === 0) {
    return {
      icon: <Film className="h-3.5 w-3.5" />,
      label: "等待上游分镜",
      tone: "neutral",
    };
  }
  if (!hasVideo) {
    return {
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
      label: "未找到视频源",
      tone: "warn",
    };
  }
  return {
    icon: <Film className="h-3.5 w-3.5" />,
    label: `${shotsCount} 帧待提取`,
    tone: "ok",
  };
}

// ── 主组件 ────────────────────────────────────────────────────────────

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

  // 订阅合成卡是否还存在 (用户可能手动删了)。
  const compositeAlive = useCardStore((s) =>
    data.compositeCardId ? s.cards.has(data.compositeCardId) : false,
  );

  const statusView = computeStatusView(
    data,
    shotsCount,
    !!videoUrl,
    compositeAlive,
  );

  const handleExtract = useCallback(() => {
    void runFrameExtraction(card.id);
  }, [card.id]);

  const handleFocusComposite = useCallback(() => {
    if (!data.compositeCardId) return;
    if (!useCardStore.getState().getCard(data.compositeCardId)) return;
    useCanvasStore
      .getState()
      .setSelectedCardIds([data.compositeCardId]);
  }, [data.compositeCardId]);

  const stopDrag = useCallback((e: React.PointerEvent | React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      {/* Header: 标题 + 状态 */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <Scissors className="h-4 w-4 text-emerald-500" />
          关键帧提取器
        </div>
        <div
          className={cn(
            "flex min-w-0 items-center gap-1 text-[10px] leading-tight",
            TONE_CLASS[statusView.tone],
          )}
        >
          {statusView.icon}
          <span className="truncate" title={statusView.label}>
            {statusView.label}
          </span>
        </div>
      </div>

      {/* 未提取:展示分镜 summary */}
      {!compositeAlive && parsed && (
        <div className="text-[10px] leading-relaxed text-muted-foreground/70 line-clamp-3">
          {parsed.summary ?? `共 ${shotsCount} 个镜头`}
        </div>
      )}

      {/* 已合成:提示 + "查看合成图" */}
      {compositeAlive && (
        <button
          type="button"
          onClick={handleFocusComposite}
          onPointerDown={stopDrag}
          className="flex flex-1 min-h-0 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-emerald-600 transition-colors hover:bg-emerald-500/10 dark:text-emerald-400"
          title="跳转到合成图卡"
        >
          <Eye className="h-4 w-4" />
          <span className="text-[10px] font-medium">查看合成图</span>
          <span className="text-[9px] opacity-70">
            合成图下方还可点「拆分」展开成独立帧卡
          </span>
        </button>
      )}

      {/* 底部按钮区 */}
      <div className="mt-auto flex flex-col gap-1.5">
        <button
          type="button"
          onClick={handleExtract}
          onPointerDown={stopDrag}
          disabled={!ready}
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
        >
          {compositeAlive && <RefreshCw className="h-3.5 w-3.5" />}
          {compositeAlive ? "重新提取" : "提取关键帧"}
        </button>
      </div>
    </div>
  );
});
