import { useRef, useCallback, useState, useEffect } from "react";
import { Upload, X, Link2 } from "lucide-react";
import { resolveImageUrl } from "@/lib/tauri";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import {
  CARD_REF_MIME,
  type CardRefPayload,
  type RefImageEntry,
  extractCardImage,
} from "@/config/model-ref-images";
import { cn } from "@/lib/utils";

interface RefImageSlotProps {
  label: string;
  description: string;
  entry?: RefImageEntry;
  onImage: (entry: RefImageEntry) => void;
  onClear: () => void;
  disabled?: boolean;
  targetCardId: string;
  slotKey: string;
}

export default function RefImageSlot({
  label,
  description,
  entry,
  onImage,
  onClear,
  disabled,
  targetCardId,
  slotKey,
}: RefImageSlotProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [displayUrl, setDisplayUrl] = useState<string | undefined>();
  const [dragOver, setDragOver] = useState(false);
  const pickMode = useCanvasStore((s) => s.pickMode);
  const isPickingThis =
    pickMode?.active &&
    pickMode.targetCardId === targetCardId &&
    pickMode.slotKey === slotKey;

  useEffect(() => {
    if (!entry?.url) {
      setDisplayUrl(undefined);
      return;
    }
    let stale = false;
    resolveImageUrl(entry.url).then((url) => {
      if (!stale) setDisplayUrl(url);
    });
    return () => {
      stale = true;
    };
  }, [entry?.url]);

  const sourceCard = useCardStore((s) =>
    entry?.sourceCardId ? s.cards.get(entry.sourceCardId) : undefined,
  );
  const sourceLabel = sourceCard
    ? sourceCard.title || `卡片 #${sourceCard.id.slice(0, 4)}`
    : undefined;

  const handleFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string")
          onImage({ url: reader.result, sourceType: "file" });
      };
      reader.readAsDataURL(file);
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

  const handlePickFromCanvas = useCallback(() => {
    useCanvasStore.getState().enterPickMode({
      targetCardId,
      slotKey,
      onPick: (sourceCardId, imageUrl) => {
        onImage({ url: imageUrl, sourceCardId, sourceType: "card" });
        useCanvasStore.getState().exitPickMode();
      },
    });
  }, [targetCardId, slotKey, onImage]);

  if (displayUrl) {
    return (
      <div className="relative flex-1 overflow-hidden rounded-lg border border-input">
        <img
          src={displayUrl}
          alt={label}
          className="h-full w-full object-cover"
        />
        {!disabled && (
          <button
            onClick={onClear}
            className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80"
          >
            <X className="h-3 w-3" />
          </button>
        )}
        <div className="absolute bottom-1 left-1 flex items-center gap-1">
          <span className="rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
            {label}
          </span>
          {sourceLabel && (
            <span className="rounded bg-primary/70 px-1.5 py-0.5 text-[10px] text-white">
              ← {sourceLabel}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-1 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-input p-2 text-muted-foreground transition-all",
        dragOver && "scale-[1.02] border-primary bg-primary/5 shadow-sm",
        isPickingThis && "animate-pulse border-primary bg-primary/10",
        !disabled &&
          !dragOver &&
          "hover:border-primary/50 hover:text-foreground",
      )}
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onPaste={onPaste}
      tabIndex={0}
    >
      <Upload className="h-4 w-4" />
      <span className="text-[10px] font-medium">{label}</span>
      <span className="text-center text-[9px] text-muted-foreground/60">
        {description}
      </span>
      <div className="mt-0.5 flex gap-1">
        <span className="text-[9px] text-muted-foreground/50">
          点击上传 / 拖入文件 / 拖入卡片
        </span>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) handlePickFromCanvas();
        }}
        className="mt-1 flex items-center gap-1 rounded-md border border-input bg-background px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-primary hover:text-primary"
      >
        <Link2 className="h-3 w-3" />
        从画布选取
      </button>
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
