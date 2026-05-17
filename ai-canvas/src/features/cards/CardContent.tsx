import { memo, useState, useEffect, useCallback } from "react";
import { ImageIcon, Loader2, Shirt, Video, RotateCw, Cloud, Music } from "lucide-react";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard } from "@/types";
import { useUIStore } from "@/stores/uiStore";
import { getDisplayUrl } from "@/lib/media";
import { isPreloaded } from "@/lib/imagePreloader";
import { autoSave } from "@/lib/autoSave";
import AIChatCard from "./AIChatCard";
import TextCard from "./TextCard";
import StickyNoteCard from "./StickyNoteCard";
import { CardErrorWithRetry } from "./CardErrorWithRetry";

const IMG_DEFER_MS = 50;

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
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-muted-foreground">{genProgress.label}</p>
            {genProgress.percent > 0 && (
              <p className="text-[10px] tabular-nums text-muted-foreground">{genProgress.percent}%</p>
            )}
          </div>
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
        <img
          src={displayUrl}
          alt=""
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
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-muted-foreground">{genProgress.label}</p>
            {genProgress.percent > 0 && (
              <p className="text-[10px] tabular-nums text-muted-foreground">{genProgress.percent}%</p>
            )}
          </div>
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
        <img src={displayUrl} alt="" decoding="async" className="h-full w-full object-cover" />
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
  const data = card.data as { content?: string; videoUrl?: string };
  const genProgress = useUIStore((s) => s.generatingCards.get(card.id));
  const cardError = useUIStore((s) => s.cardErrors.get(card.id));
  const displayUrl = data.videoUrl ? getDisplayUrl(data.videoUrl) : undefined;
  const isRemote = data.videoUrl?.startsWith("http://") || data.videoUrl?.startsWith("https://");

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
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-muted-foreground">{genProgress.label}</p>
            {genProgress.percent > 0 && (
              <p className="text-[10px] tabular-nums text-muted-foreground">{genProgress.percent}%</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (cardError && !displayUrl) {
    return <CardErrorWithRetry cardId={card.id} message={cardError} variant="panel" />;
  }

  if (displayUrl) {
    return (
      <div className="relative h-full w-full">
        <video
          src={displayUrl}
          className="h-full w-full object-cover"
          controls
          muted
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
    default:
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {card.type}
        </div>
      );
  }
});
