import { memo, useState, useEffect } from "react";
import { ImageIcon, Loader2, Shirt, Video, RotateCw, AlertCircle, Cloud } from "lucide-react";
import type { CanvasCard } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { getDisplayUrl } from "@/lib/media";
import { isPreloaded } from "@/lib/imagePreloader";
import AIChatCard from "./AIChatCard";
import TextCard from "./TextCard";
import StickyNoteCard from "./StickyNoteCard";

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

function ImagePreview({ card }: { card: CanvasCard }) {
  const data = card.data as { content?: string; imageUrl?: string };
  const genProgress = useUIStore((s) => s.generatingCards.get(card.id));
  const cardError = useUIStore((s) => s.cardErrors.get(card.id));
  const displayUrl = data.imageUrl ? getDisplayUrl(data.imageUrl) : undefined;
  const isMultiangle = card.type === "ai_multiangle";
  const PlaceholderIcon = isMultiangle ? RotateCw : ImageIcon;
  const placeholderLabel = isMultiangle ? "多角度" : "AI 图片";
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
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <AlertCircle className="h-8 w-8 text-destructive/60" />
        <p className="line-clamp-3 text-xs leading-relaxed text-destructive/80">{cardError}</p>
        <span className="text-[10px] text-muted-foreground">点击卡片查看详情</span>
      </div>
    );
  }

  if (displayUrl) {
    if (!imgReady) return <div className="h-full w-full bg-muted/20" />;
    const isRemote = data.imageUrl!.startsWith("http://") || data.imageUrl!.startsWith("https://");
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
          <div className="absolute inset-x-0 bottom-0 bg-destructive/90 px-2 py-1">
            <p className="truncate text-[10px] text-white">{cardError}</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground/50">
      <PlaceholderIcon className="h-8 w-8" />
      <span className="text-xs">{data.content ? "等待生成" : placeholderLabel}</span>
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
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <AlertCircle className="h-8 w-8 text-destructive/60" />
        <p className="line-clamp-3 text-xs leading-relaxed text-destructive/80">{cardError}</p>
        <span className="text-[10px] text-muted-foreground">点击卡片查看详情</span>
      </div>
    );
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
          <div className="absolute inset-x-0 bottom-0 bg-destructive/90 px-2 py-1">
            <p className="truncate text-[10px] text-white">{cardError}</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground/50">
      <Shirt className="h-8 w-8" />
      <span className="text-xs">AI 换装</span>
    </div>
  );
}

function VideoPreview({ card }: { card: CanvasCard }) {
  const data = card.data as { content?: string; videoUrl?: string };
  const genProgress = useUIStore((s) => s.generatingCards.get(card.id));
  const cardError = useUIStore((s) => s.cardErrors.get(card.id));

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

  if (cardError && !data.videoUrl) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <AlertCircle className="h-8 w-8 text-destructive/60" />
        <p className="line-clamp-3 text-xs leading-relaxed text-destructive/80">{cardError}</p>
        <span className="text-[10px] text-muted-foreground">点击卡片查看详情</span>
      </div>
    );
  }

  if (data.videoUrl) {
    return (
      <div className="relative h-full w-full">
        <video
          src={data.videoUrl}
          className="h-full w-full object-cover"
          controls
          muted
        />
        {cardError && (
          <div className="absolute inset-x-0 bottom-0 bg-destructive/90 px-2 py-1">
            <p className="truncate text-[10px] text-white">{cardError}</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground/50">
      <Video className="h-8 w-8" />
      <span className="text-xs">{data.content ? "等待生成" : "AI 视频"}</span>
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
    default:
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {card.type}
        </div>
      );
  }
});
