import { useState, useEffect, useCallback, useRef, memo } from "react";
import { Check, X } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useCardStore } from "@/stores/cardStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useProjectStore } from "@/stores/projectStore";
import { persistImage, getDisplayUrl } from "@/lib/media";
import { cropImageRegion } from "@/lib/cropImage";
import { autoSave } from "@/lib/autoSave";
import { sizeFromRatio } from "@/shared/constants";
import { updateProjectMeta, readMediaBase64 } from "@/platform";
import type { CanvasCard } from "@/types";
import { cn } from "@/lib/utils";

// ── Types & constants ────────────────────────────────

interface CropRect {
  x: number; // 0-1 relative
  y: number;
  w: number;
  h: number;
}

type DragMode =
  | "move"
  | "nw" | "ne" | "sw" | "se"
  | "n" | "s" | "e" | "w"
  | "draw";

const HANDLE_SIZE = 10;
const MIN_CROP = 0.03;

const CURSOR_MAP: Record<DragMode, string> = {
  move: "move",
  nw: "nwse-resize", ne: "nesw-resize",
  sw: "nesw-resize", se: "nwse-resize",
  n: "ns-resize", s: "ns-resize",
  e: "ew-resize", w: "ew-resize",
  draw: "crosshair",
};

const RATIO_PRESETS: { label: string; value: number | null }[] = [
  { label: "自由", value: null },
  { label: "1:1", value: 1 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:4", value: 3 / 4 },
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
  { label: "3:2", value: 3 / 2 },
  { label: "2:3", value: 2 / 3 },
];

function clamp01(v: number) { return Math.min(1, Math.max(0, v)); }

function applyRatio(r: CropRect, ratio: number, imgW: number, imgH: number): CropRect {
  const pixW = r.w * imgW;
  const pixH = r.h * imgH;
  const current = pixW / pixH;
  let nw = r.w, nh = r.h;
  if (current > ratio) {
    nw = (r.h * imgH * ratio) / imgW;
  } else {
    nh = (r.w * imgW) / (ratio * imgH);
  }
  nw = Math.max(MIN_CROP, Math.min(nw, 1));
  nh = Math.max(MIN_CROP, Math.min(nh, 1));
  let nx = r.x + (r.w - nw) / 2;
  let ny = r.y + (r.h - nh) / 2;
  if (nx < 0) nx = 0;
  if (ny < 0) ny = 0;
  if (nx + nw > 1) nx = 1 - nw;
  if (ny + nh > 1) ny = 1 - nh;
  return { x: nx, y: ny, w: nw, h: nh };
}

// ── Crop interaction layer (rendered over the image) ─

const CropInteraction = memo(function CropInteraction({
  rect,
  setRect,
  lockedRatio,
  imgNatW,
  imgNatH,
  containerW,
  containerH,
}: {
  rect: CropRect;
  setRect: (r: CropRect) => void;
  lockedRatio: number | null;
  imgNatW: number;
  imgNatH: number;
  containerW: number;
  containerH: number;
}) {
  const draggingRef = useRef<{
    mode: DragMode;
    startX: number;
    startY: number;
    startRect: CropRect;
  } | null>(null);

  const ratioRef = useRef(lockedRatio);
  ratioRef.current = lockedRatio;

  const cropLeft = rect.x * containerW;
  const cropTop = rect.y * containerH;
  const cropW = rect.w * containerW;
  const cropH = rect.h * containerH;

  const startDrag = useCallback((e: React.PointerEvent, mode: DragMode) => {
    e.stopPropagation();
    e.preventDefault();
    draggingRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      startRect: { ...rect },
    };

    const onMove = (ev: PointerEvent) => {
      const d = draggingRef.current;
      if (!d) return;
      const dx = (ev.clientX - d.startX) / containerW;
      const dy = (ev.clientY - d.startY) / containerH;
      const s = d.startRect;
      const ratio = ratioRef.current;
      const relRatio = ratio !== null ? (ratio * imgNatH) / imgNatW : null;

      let nx = s.x, ny = s.y, nw = s.w, nh = s.h;

      if (d.mode === "move") {
        nx = clamp01(s.x + dx);
        ny = clamp01(s.y + dy);
        if (nx + nw > 1) nx = 1 - nw;
        if (ny + nh > 1) ny = 1 - nh;
      } else if (d.mode === "draw") {
        const x2 = clamp01(s.x + dx);
        const y2 = clamp01(s.y + dy);
        nx = Math.min(s.x, x2);
        ny = Math.min(s.y, y2);
        nw = Math.max(MIN_CROP, Math.abs(x2 - s.x));
        nh = Math.max(MIN_CROP, Math.abs(y2 - s.y));
        if (relRatio !== null) {
          nh = nw / relRatio;
          if (ny + nh > 1) { nh = 1 - ny; nw = nh * relRatio; }
        }
      } else if (relRatio !== null) {
        const isCorner = ["nw", "ne", "sw", "se"].includes(d.mode);
        const isHoriz = ["e", "w"].includes(d.mode);

        if (isCorner || isHoriz) {
          if (d.mode.includes("w")) {
            nw = Math.max(MIN_CROP, s.w - dx);
            nx = s.x + s.w - nw;
          } else {
            nw = Math.max(MIN_CROP, s.w + dx);
          }
          nh = nw / relRatio;
          if (nh < MIN_CROP) { nh = MIN_CROP; nw = nh * relRatio; }
        } else {
          if (d.mode.includes("n")) {
            nh = Math.max(MIN_CROP, s.h - dy);
            ny = s.y + s.h - nh;
          } else {
            nh = Math.max(MIN_CROP, s.h + dy);
          }
          nw = nh * relRatio;
          if (nw < MIN_CROP) { nw = MIN_CROP; nh = nw / relRatio; }
        }

        if (d.mode.includes("n")) ny = s.y + s.h - nh;
        if (d.mode.includes("w")) nx = s.x + s.w - nw;

        if (nx < 0) { nx = 0; nw = Math.min(nw, 1); nh = nw / relRatio; }
        if (ny < 0) { ny = 0; nh = Math.min(nh, 1); nw = nh * relRatio; }
        if (nx + nw > 1) { nw = 1 - nx; nh = nw / relRatio; }
        if (ny + nh > 1) { nh = 1 - ny; nw = nh * relRatio; }
      } else {
        if (d.mode.includes("w")) { const newX = clamp01(s.x + dx); nw = s.w + (s.x - newX); nx = newX; }
        if (d.mode.includes("e")) { nw = clamp01(s.w + dx); if (nx + nw > 1) nw = 1 - nx; }
        if (d.mode.includes("n")) { const newY = clamp01(s.y + dy); nh = s.h + (s.y - newY); ny = newY; }
        if (d.mode.includes("s")) { nh = clamp01(s.h + dy); if (ny + nh > 1) nh = 1 - ny; }
        if (nw < MIN_CROP) { nw = MIN_CROP; nx = s.x + s.w - MIN_CROP; }
        if (nh < MIN_CROP) { nh = MIN_CROP; ny = s.y + s.h - MIN_CROP; }
      }

      setRect({ x: nx, y: ny, w: nw, h: nh });
    };

    const onUp = () => {
      draggingRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [rect, containerW, containerH, imgNatW, imgNatH, setRect]);

  const handleBgDown = useCallback((e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    const bounds = el.getBoundingClientRect();
    const rx = (e.clientX - bounds.left) / containerW;
    const ry = (e.clientY - bounds.top) / containerH;
    const newRect: CropRect = { x: clamp01(rx), y: clamp01(ry), w: MIN_CROP, h: MIN_CROP };
    setRect(newRect);

    e.stopPropagation();
    e.preventDefault();
    draggingRef.current = {
      mode: "draw",
      startX: e.clientX,
      startY: e.clientY,
      startRect: newRect,
    };

    const onMove = (ev: PointerEvent) => {
      const d = draggingRef.current;
      if (!d) return;
      const dx = (ev.clientX - d.startX) / containerW;
      const dy = (ev.clientY - d.startY) / containerH;
      const ratio = ratioRef.current;
      const relRatio = ratio !== null ? (ratio * imgNatH) / imgNatW : null;

      let nx = Math.min(d.startRect.x, clamp01(d.startRect.x + dx));
      let ny = Math.min(d.startRect.y, clamp01(d.startRect.y + dy));
      let nw = Math.max(MIN_CROP, Math.abs(dx));
      let nh = Math.max(MIN_CROP, Math.abs(dy));

      if (relRatio !== null) {
        nh = nw / relRatio;
        if (dy < 0) ny = d.startRect.y - nh;
      }

      if (nx + nw > 1) nw = 1 - nx;
      if (ny + nh > 1) nh = 1 - ny;
      if (nx < 0) nx = 0;
      if (ny < 0) ny = 0;

      setRect({ x: nx, y: ny, w: nw, h: nh });
    };

    const onUp = () => {
      draggingRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [containerW, containerH, imgNatW, imgNatH, setRect]);

  const handles: { mode: DragMode; style: React.CSSProperties }[] = [
    { mode: "nw", style: { left: -HANDLE_SIZE / 2, top: -HANDLE_SIZE / 2 } },
    { mode: "ne", style: { right: -HANDLE_SIZE / 2, top: -HANDLE_SIZE / 2 } },
    { mode: "sw", style: { left: -HANDLE_SIZE / 2, bottom: -HANDLE_SIZE / 2 } },
    { mode: "se", style: { right: -HANDLE_SIZE / 2, bottom: -HANDLE_SIZE / 2 } },
    { mode: "n", style: { left: "50%", top: -HANDLE_SIZE / 2, transform: "translateX(-50%)" } },
    { mode: "s", style: { left: "50%", bottom: -HANDLE_SIZE / 2, transform: "translateX(-50%)" } },
    { mode: "w", style: { left: -HANDLE_SIZE / 2, top: "50%", transform: "translateY(-50%)" } },
    { mode: "e", style: { right: -HANDLE_SIZE / 2, top: "50%", transform: "translateY(-50%)" } },
  ];

  return (
    <div
      className="absolute inset-0 cursor-crosshair"
      onPointerDown={handleBgDown}
    >
      {/* Dimmed mask */}
      <div className="pointer-events-none absolute bg-black/50" style={{ left: 0, top: 0, width: "100%", height: cropTop }} />
      <div className="pointer-events-none absolute bg-black/50" style={{ left: 0, top: cropTop + cropH, width: "100%", bottom: 0 }} />
      <div className="pointer-events-none absolute bg-black/50" style={{ left: 0, top: cropTop, width: cropLeft, height: cropH }} />
      <div className="pointer-events-none absolute bg-black/50" style={{ left: cropLeft + cropW, top: cropTop, right: 0, height: cropH }} />

      {/* Selection */}
      <div
        className="absolute border-2 border-white shadow-lg"
        style={{
          left: cropLeft,
          top: cropTop,
          width: cropW,
          height: cropH,
          cursor: "move",
        }}
        onPointerDown={(e) => startDrag(e, "move")}
      >
        {/* Thirds grid */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/3 top-0 h-full w-px bg-white/30" />
          <div className="absolute left-2/3 top-0 h-full w-px bg-white/30" />
          <div className="absolute left-0 top-1/3 h-px w-full bg-white/30" />
          <div className="absolute left-0 top-2/3 h-px w-full bg-white/30" />
        </div>

        {/* Handles */}
        {handles.map(({ mode, style }) => (
          <div
            key={mode}
            className="absolute z-10 rounded-sm bg-white shadow-md border border-black/20"
            style={{
              width: HANDLE_SIZE,
              height: HANDLE_SIZE,
              cursor: CURSOR_MAP[mode],
              ...style,
            }}
            onPointerDown={(e) => startDrag(e, mode)}
          />
        ))}

        {/* Size label */}
        {cropW > 60 && cropH > 30 && (
          <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md bg-black/60 px-2 py-1 text-[11px] tabular-nums text-white backdrop-blur-sm whitespace-nowrap">
            {Math.round(rect.w * imgNatW)} × {Math.round(rect.h * imgNatH)} px
          </div>
        )}
      </div>
    </div>
  );
});

// ── Main dialog ──────────────────────────────────────

export function CropDialog() {
  const { open, imageUrl, displayUrl: storeDisplayUrl, cardId } = useUIStore((s) => s.cropDialog);
  const closeCropDialog = useUIStore((s) => s.closeCropDialog);

  const [rect, setRect] = useState<CropRect>({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  const [lockedRatio, setLockedRatio] = useState<number | null>(null);
  const [cropping, setCropping] = useState(false);
  const [imgNatSize, setImgNatSize] = useState<{ w: number; h: number } | null>(null);
  const [imgError, setImgError] = useState(false);
  const [resolvedUrl, setResolvedUrl] = useState("");
  const imgRef = useRef<HTMLImageElement>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useEffect(() => {
    if (!open) return;
    setRect({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
    setLockedRatio(null);
    setCropping(false);
    setImgNatSize(null);
    setImgError(false);
    setContainerSize({ w: 0, h: 0 });
    setResolvedUrl("");

    if (!imageUrl) return;

    let cancelled = false;

    // Strategy 1: read local file via Tauri backend (handles relative + absolute paths)
    // Strategy 2: fallback to asset protocol URL
    (async () => {
      const isRemote = imageUrl.startsWith("http://") || imageUrl.startsWith("https://")
        || imageUrl.startsWith("data:") || imageUrl.startsWith("blob:");

      if (!isRemote) {
        try {
          const dataUrl = await readMediaBase64(imageUrl);
          if (!cancelled && dataUrl) { setResolvedUrl(dataUrl); return; }
        } catch { /* fallback below */ }
      }

      if (!cancelled) {
        setResolvedUrl(storeDisplayUrl || getDisplayUrl(imageUrl));
      }
    })();

    return () => { cancelled = true; };
  }, [open, imageUrl, storeDisplayUrl]);

  const measureImg = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const w = img.clientWidth;
    const h = img.clientHeight;
    if (w > 0 && h > 0) setContainerSize({ w, h });
  }, []);

  const handleImgLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setImgNatSize({ w: img.naturalWidth, h: img.naturalHeight });
    requestAnimationFrame(measureImg);
  }, [measureImg]);

  const handleImgError = useCallback(() => {
    setImgError(true);
  }, []);

  useEffect(() => {
    if (!open || !imgRef.current) return;
    const ro = new ResizeObserver(() => measureImg());
    ro.observe(imgRef.current);
    return () => ro.disconnect();
  }, [open, measureImg]);

  const selectRatio = useCallback((ratio: number | null) => {
    setLockedRatio(ratio);
    if (ratio !== null && imgNatSize) {
      setRect((prev) => applyRatio(prev, ratio, imgNatSize.w, imgNatSize.h));
    }
  }, [imgNatSize]);

  // Keyboard
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); closeCropDialog(); }
      if (e.key === "Enter" && !cropping) { e.preventDefault(); void handleConfirm(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const handleConfirm = useCallback(async () => {
    if (cropping || !imageUrl || !cardId) return;
    setCropping(true);
    try {
      const sourceCard = useCardStore.getState().getCard(cardId);
      const projectId = sourceCard?.projectId;
      if (!projectId) return;

      const { dataUrl, cropW, cropH } = await cropImageRegion(
        imageUrl, rect.x, rect.y, rect.w, rect.h,
      );
      const srcTitle = (sourceCard?.data as Record<string, unknown>)?.content as string || "";
      const cropTitle = srcTitle ? `${srcTitle}_裁剪` : "裁剪图片";
      const { localPath } = await persistImage(dataUrl, cropTitle, projectId);

      const ratio = cropW / cropH;
      const { width: newW, height: newH } = sizeFromRatio(ratio);
      const { maxZIndex } = useCardStore.getState();
      const GAP = 80;
      const now = new Date().toISOString();

      const newCard: CanvasCard = {
        id: crypto.randomUUID(),
        projectId,
        type: "ai_image",
        x: sourceCard ? sourceCard.x + sourceCard.width + GAP : 0,
        y: sourceCard ? sourceCard.y : 0,
        width: newW,
        height: newH,
        zIndex: maxZIndex + 1,
        locked: false,
        collapsed: false,
        data: { imageUrl: localPath, content: "" },
        createdAt: now,
        updatedAt: now,
      };

      useCardStore.getState().addCard(newCard);
      autoSave.markDirty(newCard.id);
      useCanvasStore.getState().setSelectedCardIds([newCard.id]);

      const count = useCardStore.getState().getCardsByProject(projectId).length;
      useProjectStore.getState().updateProject(projectId, { nodeCount: count });
      void updateProjectMeta(projectId, { nodeCount: count });

      useUIStore.getState().addToast({
        type: "success",
        title: "裁剪完成",
        description: `${Math.round(rect.w * (imgNatSize?.w ?? 0))} × ${Math.round(rect.h * (imgNatSize?.h ?? 0))} px`,
        duration: 2500,
      });
      closeCropDialog();
    } catch (err) {
      useUIStore.getState().addToast({
        type: "error",
        title: "裁剪失败",
        description: String(err),
        duration: 3000,
      });
    } finally {
      setCropping(false);
    }
  }, [cropping, imageUrl, cardId, rect, imgNatSize, closeCropDialog]);

  if (!open) return null;

  const ready = imgNatSize && containerSize.w > 0 && containerSize.h > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) closeCropDialog(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="裁剪图片"
        className="flex h-[90vh] w-[90vw] flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">裁剪图片</h2>
          <button
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={closeCropDialog}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Image area */}
        <div className="relative flex-1 overflow-hidden bg-black/90 flex items-center justify-center min-h-[200px]">
          {imgError ? (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <X className="h-8 w-8" />
              <span className="text-sm">图片加载失败</span>
              <button
                className="rounded-md bg-muted px-3 py-1 text-xs hover:bg-accent"
                onClick={() => setImgError(false)}
              >
                重试
              </button>
            </div>
          ) : (
            <div className="relative inline-block">
              {resolvedUrl ? (
                <>
                  <img
                    ref={imgRef}
                    src={resolvedUrl}
                    alt="裁剪预览"
                    className="block max-h-[calc(90vh-7rem)] max-w-full select-none"
                    draggable={false}
                    onLoad={handleImgLoad}
                    onError={handleImgError}
                  />
                  {ready && (
                    <CropInteraction
                      rect={rect}
                      setRect={setRect}
                      lockedRatio={lockedRatio}
                      imgNatW={imgNatSize.w}
                      imgNatH={imgNatSize.h}
                      containerW={containerSize.w}
                      containerH={containerSize.h}
                    />
                  )}
                </>
              ) : (
                <div className="flex h-32 items-center justify-center">
                  <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-5 py-3">
          {/* Ratio presets */}
          <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/60 px-1.5 py-1">
            {RATIO_PRESETS.map(({ label, value }) => (
              <button
                key={label}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  (value === null ? lockedRatio === null : lockedRatio === value)
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-foreground/70 hover:bg-background hover:text-foreground",
                )}
                onClick={() => selectRatio(value)}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              onClick={closeCropDialog}
            >
              取消
            </button>
            <button
              disabled={cropping}
              className={cn(
                "flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90",
                cropping && "cursor-not-allowed opacity-60",
              )}
              onClick={() => void handleConfirm()}
            >
              {cropping ? (
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              {cropping ? "裁剪中…" : "确认裁剪"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
