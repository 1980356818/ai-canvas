import { memo, useState, useEffect, useCallback, useRef } from "react";
import { ImageIcon, Loader2, Shirt, Video, RotateCw, Cloud, Music, Timer } from "lucide-react";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard } from "@/types";
import { useUIStore } from "@/stores/uiStore";
import { getDisplayUrl } from "@/lib/media";
import { ensureVideoPoster } from "@/lib/videoPoster";
import { isPreloaded } from "@/lib/imagePreloader";
import { autoSave } from "@/lib/autoSave";
import { useElapsedTimer } from "@/hooks/useElapsedTimer";
import AIChatCard from "./AIChatCard";
import TextCard from "./TextCard";
import StickyNoteCard from "./StickyNoteCard";
import FrameExtractorCard from "./FrameExtractorCard";
import { CardErrorWithRetry } from "./CardErrorWithRetry";

const IMG_DEFER_MS = 50;

export function ElapsedTimer() {
  // v5：共享全局 tick；这里"挂载即开始"的语义改成：第一次 render 拿到 mount 时刻，
  // 后续 tick 由全局 useElapsedTimer 统一驱动。
  const startedAtRef = useRef(Date.now());
  const elapsedMs = useElapsedTimer(startedAtRef.current);
  const s = Math.floor(elapsedMs / 1000);
  const text = s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return (
    <span className="inline-flex items-center gap-0.5 tabular-nums">
      <Timer className="h-2.5 w-2.5" />
      {text}
    </span>
  );
}

function useDeferredMount(delayMs: number, skipDelay: boolean): boolean {
  const [ready, setReady] = useState(skipDelay);
  useEffect(() => {
    if (skipDelay) { setReady(true); return; }
    const t = setTimeout(() => setReady(true), delayMs);
    return () => clearTimeout(t);
  }, [delayMs, skipDelay]);
  return ready;
}

interface ImageCardData {
  content?: string;
  imageUrl?: string;
  results?: Array<{ url: string; revisedPrompt?: string }>;
  selectedIndex?: number;
}

function ImagePreview({ card }: { card: CanvasCard }) {
  const data = card.data as ImageCardData;
  const genProgress = useUIStore((s) => s.generatingCards.get(card.id));
  const cardError = useUIStore((s) => s.cardErrors.get(card.id));

  const results = data.results ?? [];
  const selectedIdx = data.selectedIndex ?? 0;
  const activeUrl = results.length > 0
    ? results[Math.min(selectedIdx, results.length - 1)]?.url
    : data.imageUrl;

  const displayUrl = activeUrl ? getDisplayUrl(activeUrl) : undefined;
  const isMultiangle = card.type === "ai_multiangle";
  const PlaceholderIcon = isMultiangle ? RotateCw : ImageIcon;
  const placeholderLabel = isMultiangle ? "多角度" : "AI 图片";
  const alreadyCached = displayUrl ? isPreloaded(displayUrl) : false;
  const imgReady = useDeferredMount(IMG_DEFER_MS, alreadyCached);

  const handleSelect = useCallback(
    (idx: number) => {
      if (idx === selectedIdx) return;
      const r = results[idx];
      if (!r) return;
      const store = useCardStore.getState();
      store.updateCard(card.id, {
        data: { ...card.data, selectedIndex: idx, imageUrl: r.url },
      });
      autoSave.markDirty(card.id);
    },
    [card.id, card.data, results, selectedIdx],
  );

  if (genProgress) {
    const subs = genProgress.subs;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary/60" />
        <div className="w-full max-w-[80%] space-y-1.5">
          {subs && subs.length > 1 ? (
            <div className="flex flex-col gap-1">
              {subs.map((sub, i) => (
                <div key={i} className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  {sub.status === "error" ? (
                    <div className="h-full w-full rounded-full bg-destructive/60" />
                  ) : sub.percent > 0 ? (
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                      style={{ width: `${sub.percent}%` }}
                    />
                  ) : (
                    <div className="h-full w-1/3 animate-[shimmer_1.5s_ease-in-out_infinite] rounded-full bg-primary/60" />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              {genProgress.percent > 0 ? (
                <div
                  className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                  style={{ width: `${genProgress.percent}%` }}
                />
              ) : (
                <div className="h-full w-1/3 animate-[shimmer_1.5s_ease-in-out_infinite] rounded-full bg-primary/60" />
              )}
            </div>
          )}
          <p className="text-center text-[10px] text-muted-foreground">{genProgress.label}</p>
          <p className="text-center text-[10px] text-muted-foreground/60">
            <ElapsedTimer />
          </p>
        </div>
      </div>
    );
  }

  if (cardError && !displayUrl) {
    return <CardErrorWithRetry cardId={card.id} message={cardError} variant="panel" />;
  }

  if (displayUrl) {
    if (!imgReady) return <div className="h-full w-full bg-muted/20" />;
    const isRemote = activeUrl!.startsWith("http://") || activeUrl!.startsWith("https://");
    return (
      <div className="relative h-full w-full">
        {/* 画布上同屏可能有多张主图，必须 lazy + async 解码：
            同步解码会和 GPU 抢内存，4 张 2K+ 图同时解码足以让 WebView2 渲染端 OOM 崩溃。 */}
        <img
          src={displayUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
        {isRemote && (
          <span className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded bg-amber-500/80 px-1.5 py-0.5 text-[10px] font-medium text-white shadow-sm">
            <Cloud className="h-3 w-3" />
            远程
          </span>
        )}
        {cardError && (
          <CardErrorWithRetry cardId={card.id} message={cardError} variant="ribbon" />
        )}
        {results.length > 1 && (
          // 批量结果缩略图条：每个 <img> 解码独立占用 GPU bitmap，
          // 4 张 5MP 图同时强制解码 ≈ 80MB GPU 内存，是 WebView2 渲染端崩溃的常见诱因。
          // loading="lazy" 让 WebView 推迟到真正可见才解码，
          // decoding="async" 把解码从主线程剥离到 worker。
          <div className="absolute inset-x-0 bottom-0 flex items-end justify-center gap-1 bg-gradient-to-t from-black/50 to-transparent px-2 pb-1.5 pt-6">
            {results.map((r, i) => (
              <button
                key={i}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); handleSelect(i); }}
                className={`h-8 w-8 shrink-0 overflow-hidden rounded border-2 transition-all ${
                  i === selectedIdx
                    ? "border-white shadow-lg scale-110"
                    : "border-transparent opacity-70 hover:opacity-100"
                }`}
              >
                <img
                  src={getDisplayUrl(r.url)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
      <PlaceholderIcon className="h-12 w-12 opacity-40" />
      <span className="text-sm font-medium opacity-50">{data.content ? "等待生成" : placeholderLabel}</span>
    </div>
  );
}

function TryOnPreview({ card }: { card: CanvasCard }) {
  const data = card.data as { personImageUrl?: string; garmentImageUrl?: string; resultImageUrl?: string };
  const genProgress = useUIStore((s) => s.generatingCards.get(card.id));
  const cardError = useUIStore((s) => s.cardErrors.get(card.id));
  const rawUrl = data.resultImageUrl || data.personImageUrl;
  const displayUrl = rawUrl ? getDisplayUrl(rawUrl) : undefined;
  const alreadyCached = displayUrl ? isPreloaded(displayUrl) : false;
  const imgReady = useDeferredMount(IMG_DEFER_MS, alreadyCached);

  if (genProgress) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary/60" />
        <div className="w-full max-w-[80%] space-y-1.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            {genProgress.percent > 0 ? (
              <div
                className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                style={{ width: `${genProgress.percent}%` }}
              />
            ) : (
              <div className="h-full w-1/3 animate-[shimmer_1.5s_ease-in-out_infinite] rounded-full bg-primary/60" />
            )}
          </div>
          <p className="text-center text-[10px] text-muted-foreground">{genProgress.label}</p>
          <p className="text-center text-[10px] text-muted-foreground/60">
            <ElapsedTimer />
          </p>
        </div>
      </div>
    );
  }

  if (cardError && !displayUrl) {
    return <CardErrorWithRetry cardId={card.id} message={cardError} variant="panel" />;
  }

  if (displayUrl) {
    if (!imgReady) return <div className="h-full w-full bg-muted/20" />;
    return (
      <div className="relative h-full w-full">
        <img
          src={displayUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
        {data.resultImageUrl && (
          <span className="absolute left-2 top-2 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
            换装结果
          </span>
        )}
        {cardError && (
          <CardErrorWithRetry cardId={card.id} message={cardError} variant="ribbon" />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
      <Shirt className="h-12 w-12 opacity-40" />
      <span className="text-sm font-medium opacity-50">模特换装</span>
    </div>
  );
}

function VideoPreview({ card }: { card: CanvasCard }) {
  const data = card.data as { content?: string; videoUrl?: string; posterUrl?: string };
  const genProgress = useUIStore((s) => s.generatingCards.get(card.id));
  const cardError = useUIStore((s) => s.cardErrors.get(card.id));
  const displayUrl = data.videoUrl ? getDisplayUrl(data.videoUrl) : undefined;
  // poster 在 drop 时一次性抽好落盘,这里只是把存储路径转成 asset:// 显示 URL。
  // 用 <video poster> 而不是 <img> 叠加,是为了让用户点 controls 播放时 poster 自然
  // 被首帧替换,无需额外切换逻辑。
  const posterUrl = data.posterUrl ? getDisplayUrl(data.posterUrl) : undefined;
  const isRemote = data.videoUrl?.startsWith("http://") || data.videoUrl?.startsWith("https://");

  // 运行时解码失败兜底。drop 阶段已经做了一次 probe,但仍需此兜底：
  //   - 卡片是早先存的视频,当前机器后来卸了 HEVC 扩展
  //   - 卡片是从别的机器同步过来的,本机解不动
  //   - probe 假阳性(浏览器声称能解但实际解不动)
  // preload="none" 让 onError 只在用户点播放后才触发,所以"先看到 controls,点完才知道解不动"
  // 是预期 UX —— 总比黑卡静默强。
  const [decodeFailed, setDecodeFailed] = useState(false);
  useEffect(() => { setDecodeFailed(false); }, [displayUrl]);

  // AI 生成的视频卡(taskBridge / VideoEditor 落卡)只写了 videoUrl,没抽 poster ——
  // 只有文件 drop 路径会在 import 当场抽(useFileDrop)。给"有视频无 poster"的卡补抽
  // 首帧,否则 preload="none" 的 <video> 在点播放前是全黑的。远程 URL 由 ensureVideoPoster
  // 内部跳过(CORS taint),本地化完成后会带新 videoUrl 再触发。
  useEffect(() => {
    if (data.videoUrl && !data.posterUrl) {
      ensureVideoPoster(card.id, data.videoUrl, card.projectId);
    }
  }, [card.id, card.projectId, data.videoUrl, data.posterUrl]);

  if (genProgress) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary/60" />
        <div className="w-full max-w-[80%] space-y-1.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            {genProgress.percent > 0 ? (
              <div
                className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                style={{ width: `${genProgress.percent}%` }}
              />
            ) : (
              <div className="h-full w-1/3 animate-[shimmer_1.5s_ease-in-out_infinite] rounded-full bg-primary/60" />
            )}
          </div>
          <p className="text-center text-[10px] text-muted-foreground">{genProgress.label}</p>
          <p className="text-center text-[10px] text-muted-foreground/60">
            <ElapsedTimer />
          </p>
        </div>
      </div>
    );
  }

  if (cardError && !displayUrl) {
    return <CardErrorWithRetry cardId={card.id} message={cardError} variant="panel" />;
  }

  if (displayUrl && decodeFailed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-muted-foreground">
        <Video className="h-10 w-10 opacity-40" />
        <span className="text-sm font-medium opacity-70">视频无法解码</span>
        <span className="text-[11px] opacity-50">
          浏览器不支持该编码（如 HEVC/H.265）。<br />
          请改用 H.264 编码的 MP4。
        </span>
      </div>
    );
  }

  if (displayUrl) {
    return (
      <div className="relative h-full w-full">
        {/* preload="none" 关键：画布上多视频卡同时 mount 时，默认 metadata 会让 WebView2
            同时拉远程视频元数据 + 启动 N 个解码器，叠加图片解码就会 OOM。
            用户点击 controls 播放时才真正拉数据。 */}
        {/* onEnded 回 t=0 而不是加 loop:用户要求"播完回第一帧但不循环"。
            原生 <video> 播完会停在最后一帧,WebView2 在 ended 后还会偶发清空
            帧缓冲变成黑屏(尤其卡片不在视口时被节流后)。seek 回 0 让首帧重绘,
            视觉效果接近最初的 poster。 */}
        <video
          src={displayUrl}
          poster={posterUrl}
          className="h-full w-full object-cover"
          controls
          muted
          preload="none"
          onError={() => setDecodeFailed(true)}
          onEnded={(e) => {
            const v = e.currentTarget;
            v.pause();
            try { v.currentTime = 0; } catch { /* seek 偶发抛 InvalidStateError,忽略 */ }
          }}
        />
        {isRemote && (
          <span className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded bg-amber-500/80 px-1.5 py-0.5 text-[10px] font-medium text-white shadow-sm">
            <Cloud className="h-3 w-3" />
            远程
          </span>
        )}
        {cardError && (
          <CardErrorWithRetry cardId={card.id} message={cardError} variant="ribbon" />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
      <Video className="h-12 w-12 opacity-40" />
      <span className="text-sm font-medium opacity-50">{data.content ? "等待生成" : "AI 视频"}</span>
    </div>
  );
}

function AudioCardPreview({ card }: { card: CanvasCard }) {
  const data = card.data as { audioUrl?: string; filename?: string };
  const displayUrl = data.audioUrl ? getDisplayUrl(data.audioUrl) : undefined;

  return (
    <div className="flex h-full items-center gap-2.5 px-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
        <Music className="h-4.5 w-4.5 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">
          {data.filename || "音频文件"}
        </p>
        {displayUrl && (
          <audio
            src={displayUrl}
            controls
            className="mt-1 h-6 w-full"
            style={{ maxHeight: "24px" }}
          />
        )}
      </div>
    </div>
  );
}

export default memo(function CardContent({ card }: { card: CanvasCard }) {
  switch (card.type) {
    case "ai_chat":
      return <AIChatCard card={card} />;
    case "text":
      return <TextCard card={card} />;
    case "sticky_note":
      return <StickyNoteCard card={card} />;
    case "ai_image":
    case "ai_multiangle":
      return <ImagePreview card={card} />;
    case "ai_video":
      return <VideoPreview card={card} />;
    case "ai_tryon":
      return <TryOnPreview card={card} />;
    case "audio":
      return <AudioCardPreview card={card} />;
    case "frame_extractor":
      return <FrameExtractorCard card={card} />;
    default:
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {card.type}
        </div>
      );
  }
});
