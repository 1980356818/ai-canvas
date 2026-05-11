import { useRef, useCallback, useEffect, useLayoutEffect, useState } from "react";
import { useCanvasStore, liveViewport, subscribeViewport } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { isEnhancerModel } from "@/config/model-ref-images";
import EditorSwitch from "./EditorSwitch";

const GAP = 12;
const MIN_EDITOR_WIDTH = 360;
const MIN_EDITOR_HEIGHT = 90;

const EDITOR_SIZES: Record<string, { height: number; minWidth: number }> = {
  ai_chat: { height: 140, minWidth: 560 },
  ai_image: { height: 160, minWidth: 560 },
  ai_video: { height: 150, minWidth: 560 },
  ai_tryon: { height: 150, minWidth: 560 },
  ai_multiangle: { height: 88, minWidth: 400 },
  text: { height: 200, minWidth: 400 },
  sticky_note: { height: 160, minWidth: 360 },
};
const DEFAULT_SIZE = { height: 120, minWidth: 400 };

const sizeMemory = new Map<string, { w: number; h: number }>();

export default function FloatingEditor() {
  const editingCardId = useCanvasStore((s) => s.editingCardId);
  const card = useCardStore((s) =>
    editingCardId ? s.cards.get(editingCardId) : undefined,
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const [userSize, setUserSize] = useState<{ w: number; h: number } | null>(null);
  const prevCardId = useRef<string | null>(null);

  if (editingCardId !== prevCardId.current) {
    prevCardId.current = editingCardId;
    setUserSize(editingCardId ? sizeMemory.get(editingCardId) ?? null : null);
  }

  const close = useCallback(() => {
    useCanvasStore.getState().setEditingCardId(null);
  }, []);

  useEffect(() => {
    if (!editingCardId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingCardId, close]);

  const startResize = useCallback(
    (e: React.PointerEvent, edge: "right" | "bottom" | "corner") => {
      e.preventDefault();
      e.stopPropagation();
      const el = panelRef.current;
      const handle = e.currentTarget as HTMLElement;
      if (!el) return;

      handle.setPointerCapture(e.pointerId);

      const zoom = useCanvasStore.getState().viewport.zoom;
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = el.offsetWidth;
      const startH = el.offsetHeight;

      const onMove = (ev: PointerEvent) => {
        ev.stopPropagation();
        const dx = (ev.clientX - startX) / zoom;
        const dy = (ev.clientY - startY) / zoom;
        const newW = edge === "bottom" ? startW : Math.max(MIN_EDITOR_WIDTH, startW + dx);
        const newH = edge === "right" ? startH : Math.max(MIN_EDITOR_HEIGHT, startH + dy);
        const size = { w: newW, h: newH };
        setUserSize(size);
        const cid = useCanvasStore.getState().editingCardId;
        if (cid) sizeMemory.set(cid, size);
      };

      const onUp = (ev: PointerEvent) => {
        ev.stopPropagation();
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
      };

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    },
    [],
  );

  const hasError = useUIStore((s) => editingCardId ? s.cardErrors.has(editingCardId) : false);

  // imperative 跟随：viewport / dragOffsets 高频变化时通过 ref 直接同步
  // left / top / transform，避免重渲染整个编辑器面板。
  useLayoutEffect(() => {
    if (!editingCardId) return;
    if (!panelRef.current) return;

    let rafId = 0;
    let scheduled = false;
    let prevSig = "";

    const sync = () => {
      scheduled = false;
      const panel = panelRef.current;
      if (!panel) return;
      const c = useCardStore.getState().cards.get(editingCardId);
      if (!c) return;
      const vp = liveViewport;
      const off = useCanvasStore.getState().dragOffsets.get(editingCardId);
      const offDx = off ? off.dx * vp.zoom : 0;
      const offDy = off ? off.dy * vp.zoom : 0;

      // Use transform: scale() instead of CSS zoom to avoid the
      // non-standard zoom property multiplying left/top/offsetWidth.
      // With transform, offsetWidth returns the unzoomed layout width
      // and left/top are pure screen-space coordinates.
      const w = panel.offsetWidth;
      const scaledW = w * vp.zoom;
      const cardScreenLeft = c.x * vp.zoom + vp.x + offDx;
      const cardScreenCenterX = cardScreenLeft + (c.width * vp.zoom) / 2;
      const screenLeft = cardScreenCenterX - scaledW / 2;
      const screenTop = (c.y + c.height) * vp.zoom + vp.y + offDy + GAP;

      const sig = `${screenLeft}|${screenTop}|${vp.zoom}`;
      if (sig === prevSig) return;
      prevSig = sig;

      panel.style.left = `${screenLeft}px`;
      panel.style.top = `${screenTop}px`;
      panel.style.transform = `scale(${vp.zoom})`;
      panel.style.transformOrigin = '0 0';
      if ((panel.style as any).zoom) (panel.style as any).zoom = '';
      panel.dataset.editorZoom = String(vp.zoom);
    };

    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      rafId = requestAnimationFrame(sync);
    };

    sync();

    const unsubVp = subscribeViewport(schedule);
    const unsubCanvas = useCanvasStore.subscribe((s, prev) => {
      if (s.dragOffsets !== prev.dragOffsets) schedule();
    });
    const unsubCards = useCardStore.subscribe((s, prev) => {
      if (s.cards !== prev.cards) schedule();
    });

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      unsubVp();
      unsubCanvas();
      unsubCards();
    };
  }, [editingCardId, userSize]);

  if (!card) return null;

  const { height: baseHeight, minWidth } = EDITOR_SIZES[card.type] ?? DEFAULT_SIZE;

  const data = card.data as Record<string, unknown> | undefined;
  const modelId = (data?.model as string) || "";
  const isEnhancer = isEnhancerModel(modelId);
  const refImages = data?.refImages as Record<string, unknown> | undefined;
  const hasRefImages = refImages && Object.keys(refImages).length > 0;
  const upstreamTexts = data?.upstreamTexts as Record<string, unknown> | undefined;
  const hasUpstream = upstreamTexts && Object.keys(upstreamTexts).length > 0;
  const refFrames = data?.refFrames as unknown[] | undefined;
  const hasRefFrames = refFrames && refFrames.length > 0;
  const refAudios = data?.refAudios as unknown[] | undefined;
  const hasRefAudios = refAudios && refAudios.length > 0;
  const refVideos = data?.refVideos as unknown[] | undefined;
  const hasRefVideos = refVideos && refVideos.length > 0;
  const isLocked = !!(data?._locked);
  let autoHeight = isEnhancer ? 70 : baseHeight;
  if (card.type === "ai_multiangle" || card.type === "ai_tryon") {
    if (hasError) autoHeight += 48;
  } else {
    if (card.type === "ai_video") autoHeight += 40;
    if (hasRefImages) autoHeight += isEnhancer ? 80 : 112;
    else if (isEnhancer) autoHeight += 60;
    if (!isLocked && hasUpstream) autoHeight += 64;
    if (hasRefFrames) autoHeight += 90;
    if (hasRefAudios) autoHeight += 120;
    if (hasRefVideos) autoHeight += 120;
    if (hasError) autoHeight += 48;
  }

  const width = userSize ? userSize.w : Math.max(minWidth, card.width);
  const height = userSize ? userSize.h : autoHeight;

  return (
    <div
      ref={panelRef}
      className="absolute z-40 overflow-hidden rounded-xl border border-border bg-card shadow-xl"
      data-floating-editor
      data-editor-zoom="1"
      // left / top / transform 由上方 useLayoutEffect 通过 ref imperative 设置
      style={{
        width,
        height,
      }}
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        e.stopPropagation();
        const el = e.target as HTMLElement;
        if (el.isContentEditable || el.closest("[contenteditable]")) {
          return;
        }
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
          return;
        }
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="h-full overflow-auto">
        <EditorSwitch card={card} />
      </div>

      {/* Right edge resize handle */}
      <div
        className="absolute right-0 top-0 h-full w-1.5 cursor-e-resize opacity-0 transition-opacity hover:opacity-100 hover:bg-primary/20"
        onPointerDown={(e) => startResize(e, "right")}
      />
      {/* Bottom edge resize handle */}
      <div
        className="absolute bottom-0 left-0 h-1.5 w-full cursor-s-resize opacity-0 transition-opacity hover:opacity-100 hover:bg-primary/20"
        onPointerDown={(e) => startResize(e, "bottom")}
      />
      {/* Corner resize handle */}
      <div
        className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize"
        onPointerDown={(e) => startResize(e, "corner")}
      >
        <svg
          className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
          viewBox="0 0 10 10"
          fill="currentColor"
        >
          <circle cx="8" cy="8" r="1.2" />
          <circle cx="4" cy="8" r="1.2" />
          <circle cx="8" cy="4" r="1.2" />
        </svg>
      </div>
    </div>
  );
}
