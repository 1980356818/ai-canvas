import { useRef, useCallback, useState, useEffect } from "react";
import { Upload, X } from "lucide-react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import {
  CARD_REF_MIME,
  type CardRefPayload,
  type RefImageEntry,
} from "@/config/model-ref-images";
import { cn } from "@/lib/utils";
import { persistImage, getDisplayUrl, normalizeToStoragePath } from "@/lib/media";
import { ensureDisplayableImage } from "@/lib/heicConverter";

const REF_REORDER_MIME = "application/x-ref-slot-reorder";

interface RefImageSlotProps {
  label: string;
  description: string;
  entry?: RefImageEntry;
  onImage: (entry: RefImageEntry) => void;
  onClear: () => void;
  onRefClick?: () => void;
  onReorder?: (fromSlotKey: string) => void;
  disabled?: boolean;
  targetCardId: string;
  slotKey: string;
  index?: number;
  highlighted?: boolean;
}

export default function RefImageSlot({
  label,
  description: _description,
  entry,
  onImage,
  onClear,
  onRefClick,
  onReorder,
  disabled,
  targetCardId,
  slotKey,
  index,
  highlighted,
}: RefImageSlotProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [cardDragOver, setCardDragOver] = useState(false);
  const pickMode = useCanvasStore((s) => s.pickMode);
  const isPickingThis =
    pickMode?.active &&
    pickMode.targetCardId === targetCardId &&
    pickMode.slotKey === slotKey;

  const displayUrl = entry?.url ? getDisplayUrl(entry.url) : undefined;

  // Listen for custom events dispatched by CardShell during pointer-based drag
  useEffect(() => {
    const el = slotRef.current;
    if (!el || disabled) return;

    const onHover = (e: Event) => {
      setCardDragOver((e as CustomEvent).detail.active);
    };
    const onCardDrop = (e: Event) => {
      const { cardId, imageUrl } = (e as CustomEvent).detail;
      onImage({ url: normalizeToStoragePath(imageUrl) ?? imageUrl, sourceCardId: cardId, sourceType: "card" });
      setCardDragOver(false);
    };

    el.addEventListener("canvas-card-hover", onHover);
    el.addEventListener("canvas-card-drop", onCardDrop);
    return () => {
      el.removeEventListener("canvas-card-hover", onHover);
      el.removeEventListener("canvas-card-drop", onCardDrop);
    };
  }, [disabled, onImage]);


  const handleFile = useCallback(
    async (rawFile: File) => {
      if (!rawFile.type.startsWith("image/")) return;
      const file = await ensureDisplayableImage(rawFile);
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
      // 跟随目标卡片归属，避免读全局当前项目导致跨项目串档。
      const pid = useCardStore.getState().getCard(targetCardId)?.projectId;
      const { localPath, width, height } = await persistImage(dataUrl, undefined, pid);
      onImage({ url: localPath, sourceType: "file", width, height });
    },
    [onImage, targetCardId],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);

      const cardRefJson = e.dataTransfer.getData(CARD_REF_MIME);
      if (cardRefJson) {
        try {
          const payload: CardRefPayload = JSON.parse(cardRefJson);
          if (payload.imageUrl) {
            onImage({
              url: normalizeToStoragePath(payload.imageUrl) ?? payload.imageUrl,
              sourceCardId: payload.cardId,
              sourceType: "card",
            });
            return;
          }
        } catch { /* fall through to file handling */ }
      }

      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile, onImage],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const file = Array.from(e.clipboardData.items)
        .find((i) => i.type.startsWith("image/"))
        ?.getAsFile();
      if (file) {
        e.preventDefault();
        handleFile(file);
      }
    },
    [handleFile],
  );


  const isHighlighted = dragOver || cardDragOver;

  const [reorderOver, setReorderOver] = useState(false);
  const isDraggable = !disabled && !!onReorder;

  const handleReorderDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData(REF_REORDER_MIME, slotKey);
      e.dataTransfer.effectAllowed = "move";
    },
    [slotKey],
  );

  const handleReorderDragOver = useCallback(
    (e: React.DragEvent) => {
      if (disabled || !onReorder) return;
      if (e.dataTransfer.types.includes(REF_REORDER_MIME)) {
        e.preventDefault();
        e.stopPropagation();
        setReorderOver(true);
      }
    },
    [disabled, onReorder],
  );

  const handleReorderDragLeave = useCallback(() => {
    setReorderOver(false);
  }, []);

  const handleReorderDrop = useCallback(
    (e: React.DragEvent) => {
      setReorderOver(false);
      const fromKey = e.dataTransfer.getData(REF_REORDER_MIME);
      if (fromKey && fromKey !== slotKey && onReorder) {
        e.preventDefault();
        e.stopPropagation();
        onReorder(fromKey);
      }
    },
    [slotKey, onReorder],
  );

  if (displayUrl) {
    return (
      <div
        ref={slotRef}
        data-ref-slot
        draggable={isDraggable}
        onDragStart={isDraggable ? handleReorderDragStart : undefined}
        onDragOver={handleReorderDragOver}
        onDragLeave={handleReorderDragLeave}
        onDrop={handleReorderDrop}
        className={cn(
          "relative aspect-square w-[96px] shrink-0 transition-all duration-200",
          highlighted && "scale-105 drop-shadow-md",
          isDraggable && "cursor-grab active:cursor-grabbing",
          !isDraggable && onRefClick && "cursor-pointer",
          reorderOver && "scale-105 ring-2 ring-primary ring-offset-1",
        )}
      >
        <div
          className={cn(
            "h-full w-full overflow-hidden rounded-lg border bg-muted/30 transition-colors",
            highlighted ? "border-primary ring-2 ring-primary/30" : "border-input",
            reorderOver && "border-primary",
            onRefClick && "hover:border-primary/60 hover:shadow-sm",
          )}
          onClick={onRefClick}
          title={onRefClick ? "点击插入引用到提示词" : undefined}
        >
          <img
            src={displayUrl}
            alt={label}
            className="h-full w-full object-contain"
            loading="lazy"
            decoding="async"
          />
        </div>
        {index != null && (
          <span className="absolute left-0 top-0 z-10 flex h-5 w-5 -translate-x-1/4 -translate-y-1/4 items-center justify-center rounded-full bg-black/70 text-[10px] font-bold text-white shadow-sm">
            {index + 1}
          </span>
        )}
        {!disabled && (
          <button
            onClick={onClear}
            className="absolute right-1 top-1 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      ref={slotRef}
      data-ref-slot
      className={cn(
        "relative flex aspect-square w-[96px] shrink-0 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-input text-muted-foreground transition-all",
        isHighlighted && "scale-[1.02] border-primary bg-primary/5 shadow-sm",
        cardDragOver && "ring-2 ring-primary ring-offset-1",
        isPickingThis && "animate-pulse border-primary bg-primary/10",
        highlighted && "scale-105 border-primary bg-primary/10 ring-2 ring-primary/30 drop-shadow-md",
        !disabled &&
          !isHighlighted &&
          !highlighted &&
          "hover:border-primary/50 hover:text-foreground",
      )}
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onPaste={onPaste}
      tabIndex={0}
    >
      {cardDragOver ? (
        <Upload className="h-5 w-5 text-primary" />
      ) : (
        <>
          <Upload className="h-4 w-4" />
          <span className="text-[9px] font-medium leading-tight">{label}</span>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*,.heic,.heif"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
