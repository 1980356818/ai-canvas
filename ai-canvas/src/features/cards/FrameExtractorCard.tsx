import { memo, useCallback, useMemo, useRef, useState, useLayoutEffect } from "react";
import {
  Loader2,
  Scissors,
  AlertTriangle,
  CheckCircle2,
  Film,
  Layers,
} from "lucide-react";
import {
  parseShotsFromText,
  resolveVideoUrl,
  runFrameExtraction,
  spawnFrameAsCard,
  spawnAllUnextractedFrames,
  formatTimestamp,
  type FrameExtractorData,
  type ExtractedFrame,
} from "@/lib/frameExtraction";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import { getDisplayUrl } from "@/lib/media";
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

/** 缩略图固定高度;宽度按 frameSize 比例算。 */
const THUMB_H = 56;
/** 拖拽判定阈值(px),小于此值视为点击不生卡。 */
const DRAG_THRESHOLD = 4;

/** 屏幕坐标 → 画布坐标(复用 ImageToolbar 的逻辑)。 */
function screenToCanvas(clientX: number, clientY: number) {
  const container = document.querySelector("[data-canvas-viewport]");
  const rect = container?.getBoundingClientRect();
  const vp = useCanvasStore.getState().viewport;
  const x = rect ? clientX - rect.left : clientX;
  const y = rect ? clientY - rect.top : clientY;
  return {
    x: (x - vp.x) / vp.zoom,
    y: (y - vp.y) / vp.zoom,
  };
}

/** 把 (card.data, parsed, videoUrl) 翻译成状态行展示。 */
function computeStatusView(
  data: FrameExtractorData,
  shotsCount: number,
  hasVideo: boolean,
  liveSplitCount: number,
): StatusView {
  const extractedCount = data.extractedFrames?.length ?? 0;
  const status = data.status ?? "idle";

  if (status === "running") {
    return {
      icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
      label: `正在提取 ${shotsCount} 帧…`,
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
  if (status === "done" && extractedCount > 0) {
    return {
      icon: <CheckCircle2 className="h-3.5 w-3.5" />,
      label:
        liveSplitCount > 0
          ? `已提取 ${extractedCount} · 已拆 ${liveSplitCount}`
          : `已提取 ${extractedCount} 帧`,
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

// ── 单帧缩略图:支持拖出生卡 / 点击聚焦已派生子卡 ─────────────────────

interface FrameThumbProps {
  extractorCardId: string;
  frame: ExtractedFrame;
  aspect: number; // width / height
  derivedExists: boolean;
}

const FrameThumb = memo(function FrameThumb({
  extractorCardId,
  frame,
  aspect,
  derivedExists,
}: FrameThumbProps) {
  const thumbW = Math.max(40, Math.round(THUMB_H * aspect));
  const [dragging, setDragging] = useState<{ cx: number; cy: number } | null>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  const movedRef = useRef(false);

  const focusDerived = useCallback(() => {
    if (!frame.derivedCardId) return;
    const exists = useCardStore.getState().getCard(frame.derivedCardId);
    if (!exists) return;
    useCanvasStore.getState().setSelectedCardIds([frame.derivedCardId]);
  }, [frame.derivedCardId]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      // 已拆 → 走 click-only(由 onClick 处理聚焦),不启动拖拽
      if (derivedExists) {
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      movedRef.current = false;
      const startX = e.clientX;
      const startY = e.clientY;
      setDragging({ cx: startX, cy: startY });

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!movedRef.current && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
          movedRef.current = true;
        }
        const fl = floatRef.current;
        if (fl) {
          fl.style.left = `${ev.clientX - thumbW / 2}px`;
          fl.style.top = `${ev.clientY - THUMB_H / 2}px`;
        }
      };

      const onUp = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setDragging(null);

        if (!movedRef.current) return; // 没拖动,啥都不做

        // 拖出 → 生卡
        const dropPos = screenToCanvas(ev.clientX, ev.clientY);
        void spawnFrameAsCard(extractorCardId, frame.index, dropPos);

        // 拦截 pointerup 之后浏览器合成的 click,避免误触父级选区
        const blockClick = (ce: Event) => {
          ce.stopPropagation();
          ce.stopImmediatePropagation();
          ce.preventDefault();
        };
        window.addEventListener("click", blockClick, { capture: true, once: true });
        setTimeout(
          () => window.removeEventListener("click", blockClick, { capture: true }),
          200,
        );
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [extractorCardId, frame.index, derivedExists, thumbW],
  );

  // 浮动框初始位置(只在 dragging 切换时设一次,之后由 onMove imperative 更新)
  useLayoutEffect(() => {
    if (!dragging) return;
    const fl = floatRef.current;
    if (!fl) return;
    fl.style.left = `${dragging.cx - thumbW / 2}px`;
    fl.style.top = `${dragging.cy - THUMB_H / 2}px`;
  }, [dragging, thumbW]);

  const onClickThumb = useCallback(
    (e: React.MouseEvent) => {
      if (!derivedExists) return;
      e.stopPropagation();
      focusDerived();
    },
    [derivedExists, focusDerived],
  );

  return (
    <>
      <div
        className={cn(
          "group relative shrink-0 overflow-hidden rounded-md border border-border/60 bg-muted shadow-sm transition-all",
          derivedExists
            ? "cursor-pointer opacity-50 hover:opacity-80"
            : "cursor-grab hover:scale-105 hover:shadow-md active:cursor-grabbing",
          dragging && "opacity-30",
        )}
        style={{ width: thumbW, height: THUMB_H }}
        onPointerDown={handlePointerDown}
        onClick={onClickThumb}
        title={
          derivedExists
            ? `分镜 ${frame.index} · ${formatTimestamp(frame.timestamp)} · 已拆 · 点击跳转`
            : `分镜 ${frame.index} · ${formatTimestamp(frame.timestamp)} · 拖出生卡`
        }
      >
        <img
          src={getDisplayUrl(frame.framePath)}
          alt={`分镜 ${frame.index}`}
          className="h-full w-full object-cover"
          draggable={false}
        />
        {/* 时间戳角标(左上) */}
        <div className="pointer-events-none absolute left-0.5 top-0.5 rounded bg-black/70 px-1 py-px text-[9px] font-medium leading-tight text-white">
          {formatTimestamp(frame.timestamp)}
        </div>
        {/* 已拆角标(右上) */}
        {derivedExists && (
          <div className="pointer-events-none absolute right-0.5 top-0.5 rounded bg-emerald-500 px-1 py-px text-[9px] font-medium leading-tight text-white">
            已拆
          </div>
        )}
      </div>
      {dragging && (
        <div
          ref={floatRef}
          className="pointer-events-none fixed z-[9999] overflow-hidden rounded-md border-2 border-primary shadow-xl"
          style={{ width: thumbW, height: THUMB_H }}
        >
          <img
            src={getDisplayUrl(frame.framePath)}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        </div>
      )}
    </>
  );
});

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
  const frames = data.extractedFrames ?? [];
  const hasExtracted = frames.length > 0;

  // 订阅 cardStore: 用稳定的 string key 表示"现存的派生子卡 id 集合",
  // 这样删卡 / 重生时 UI 能实时同步,又不会因为 Set 引用变化导致每次都 re-render。
  const liveDerivedKey = useCardStore((s) => {
    const parts: string[] = [];
    for (const f of frames) {
      if (f.derivedCardId && s.cards.has(f.derivedCardId)) {
        parts.push(f.derivedCardId);
      }
    }
    return parts.join("|");
  });
  const liveDerivedIds = useMemo(
    () => new Set(liveDerivedKey ? liveDerivedKey.split("|") : []),
    [liveDerivedKey],
  );
  const liveSplitCount = liveDerivedIds.size;
  const allSplit = hasExtracted && liveSplitCount === frames.length;

  const statusView = computeStatusView(data, shotsCount, !!videoUrl, liveSplitCount);

  const aspect = useMemo(() => {
    const sz = data.frameSize;
    if (sz && sz.height > 0) return sz.width / sz.height;
    return 16 / 9;
  }, [data.frameSize]);

  const handleExtract = useCallback(() => {
    void runFrameExtraction(card.id);
  }, [card.id]);

  const handleSplitAll = useCallback(() => {
    void spawnAllUnextractedFrames(card.id);
  }, [card.id]);

  /** 阻止指针事件冒泡到 canvas(否则会触发卡片拖动 / 视口平移)。 */
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
      {!hasExtracted && parsed && (
        <div className="text-[10px] leading-relaxed text-muted-foreground/70 line-clamp-3">
          {parsed.summary ?? `共 ${shotsCount} 个镜头`}
        </div>
      )}

      {/* 已提取:横向滚动条带 */}
      {hasExtracted && (
        <div
          className="frame-strip flex-1 min-h-0 overflow-x-auto overflow-y-hidden"
          onPointerDown={stopDrag}
          onWheel={(e) => e.stopPropagation()}
        >
          <div className="flex h-full items-center gap-1.5 py-0.5">
            {frames.map((f) => (
              <FrameThumb
                key={f.index}
                extractorCardId={card.id}
                frame={f}
                aspect={aspect}
                derivedExists={!!f.derivedCardId && liveDerivedIds.has(f.derivedCardId)}
              />
            ))}
          </div>
        </div>
      )}

      {/* 底部按钮区 */}
      <div className="mt-auto flex flex-col gap-1.5">
        {hasExtracted && !allSplit && (
          <button
            type="button"
            onClick={handleSplitAll}
            onPointerDown={stopDrag}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Layers className="h-3.5 w-3.5" />
            一键拆分
            <span className="opacity-70">
              ({frames.length - liveSplitCount} 张)
            </span>
          </button>
        )}
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
