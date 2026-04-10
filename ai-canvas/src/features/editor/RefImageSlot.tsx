import { useRef, useCallback, useState, useEffect } from "react";
import { Upload, X } from "lucide-react";
import { useCanvasStore } from "@/stores/canvasStore";
import {
  CARD_REF_MIME,
  type CardRefPayload,
  type RefImageEntry,
} from "@/config/model-ref-images";
import { cn } from "@/lib/utils";
import { persistImage, getDisplayUrl } from "@/lib/media";

interface RefImageSlotProps {
  label: string;
  description: string;
  entry?: RefImageEntry;
  onImage: (entry: RefImageEntry) => void;
  onClear: () => void;
  disabled?: boolean;
  targetCardId: string;
  slotKey: string;
  index?: number;
}

export default function RefImageSlot({
  label,
  description: _description,
  entry,
  onImage,
  onClear,
  disabled,
  targetCardId,
  slotKey,
  index,
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
      onImage({ url: imageUrl, sourceCardId: cardId, sourceType: "card" });
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
    async (file: File) => {
      if (!file.type.startsWith("image/")) return;
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
      const relativePath = await persistImage(dataUrl);
      onImage({ url: relativePath, sourceType: "file" });
    },
    [onImage],
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
              url: payload.imageUrl,
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

  if (displayUrl) {
    return (
      <div
        ref={slotRef}
        data-ref-slot
        className="relative aspect-square w-[96px] shrink-0"
      >
        <div className="h-full w-full overflow-hidden rounded-lg border border-input bg-muted/30">
          <img
            src={displayUrl}
            alt={label}
            className="h-full w-full object-contain"
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
        !disabled &&
          !isHighlighted &&
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
        accept="image/*"
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
