import { useRef, useCallback, useEffect, useLayoutEffect, useState } from "react";
import { useCanvasStore, liveViewport, subscribeViewport } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import EditorSwitch from "./EditorSwitch";

const GAP = 12;
const MIN_EDITOR_WIDTH = 360;
const MIN_EDITOR_HEIGHT = 90;
// 自适应高度上限:面板最多占视口高度的这个比例,超出由内容区自身滚动
// (内容极多时面板不会高过屏幕)。
const MAX_EDITOR_HEIGHT_RATIO = 0.72;

const EDITOR_SIZES: Record<string, { height: number; minWidth: number }> = {
  ai_chat: { height: 140, minWidth: 560 },
  ai_image: { height: 160, minWidth: 560 },
  ai_video: { height: 150, minWidth: 560 },
  ai_tryon: { height: 150, minWidth: 560 },
  ai_multiangle: { height: 175, minWidth: 400 },
  text: { height: 200, minWidth: 400 },
  sticky_note: { height: 160, minWidth: 360 },
};
const DEFAULT_SIZE = { height: 120, minWidth: 400 };

const sizeMemory = new Map<string, { w: number; h: number }>();

export default function FloatingEditor() {
  const editingCardId = useCanvasStore((s) => s.editingCardId);
  const scrubberActiveCardId = useCanvasStore((s) => s.scrubberActiveCardId);
  const card = useCardStore((s) =>
    editingCardId ? s.cards.get(editingCardId) : undefined,
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [userSize, setUserSize] = useState<{ w: number; h: number } | null>(null);
  // 测得的内容自然高度(null=尚未测量,先用基础估算值避免首帧跳动)。
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const prevCardId = useRef<string | null>(null);

  if (editingCardId !== prevCardId.current) {
    prevCardId.current = editingCardId;
    setUserSize(editingCardId ? sizeMemory.get(editingCardId) ?? null : null);
    setMeasuredHeight(null);
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

  // 面板高度自适应内容(规范化:取代过去按"有无参考图/上游/视频…"逐项 += 魔法数的脆弱估算
  // —— 每多一种内容、或参考图多到换行,旧估算就会偏小,把输入框/生成按钮挤出可视区)。
  // 改为直接测量编辑器内容的自然高度,面板据此自适应;手动拖拽改过尺寸(userSize)后不再自适应。
  // 内容区(下方 overflow-auto)在未手动调整时为内容驱动高度,因此 scrollHeight 即为自然高度,
  // 内容增减都能即时反映(增长会撑高面板、减少会收回);超过上限则由内容区自身滚动。
  useLayoutEffect(() => {
    if (!editingCardId || userSize) return;
    const el = contentRef.current;
    if (!el) return;
    const measure = () => {
      const next = el.scrollHeight;
      setMeasuredHeight((prev) =>
        prev != null && Math.abs(prev - next) <= 1 ? prev : next,
      );
    };
    measure();
    // 观察内容根节点 + 容器本身:参考图换行、上游增减、报错出现等任何重排都会触发重新测量。
    const ro = new ResizeObserver(measure);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    ro.observe(el);
    return () => ro.disconnect();
  }, [editingCardId, userSize]);

  if (!card) return null;

  // 拖帧焦点模式: VideoToolbar 进入挑帧时把卡下方空间让给时间轴 + FrameChip,
  // 此时不渲染编辑器。退出拖帧后 (scrubberActiveCardId 清空) 自动恢复。
  if (scrubberActiveCardId === card.id) return null;

  const { height: baseInitialHeight, minWidth } = EDITOR_SIZES[card.type] ?? DEFAULT_SIZE;
  const maxAutoHeight = Math.max(
    320,
    Math.round((typeof window !== "undefined" ? window.innerHeight : 900) * MAX_EDITOR_HEIGHT_RATIO),
  );
  // 自适应高度时给提示词框封顶(PromptTextarea 读 --prompt-max-h 内部滚动),
  // 留出"生成"按钮 + 模型行 + 内边距(~140px)的空间,提示词再长也不会把按钮挤出可视区。
  // 上限 240px 让输入框保持紧凑;手动拉伸(userSize)时不设此变量 → 提示词框照常填满。
  const promptMaxH = Math.max(110, Math.min(240, maxAutoHeight - 140));

  const width = userSize ? userSize.w : Math.max(minWidth, card.width);
  // 自适应高度:测得自然高度则用之(夹在 [MIN, maxAuto] 内),尚未测量时退回基础估算值。
  const autoHeight =
    measuredHeight != null
      ? Math.min(Math.max(measuredHeight, MIN_EDITOR_HEIGHT), maxAutoHeight)
      : baseInitialHeight;
  const height = userSize ? userSize.h : autoHeight;

  // 仅自适应高度时下发提示词封顶变量;手动拉伸时不设,后代 PromptTextarea 回退 none(不封顶)。
  const panelStyle: React.CSSProperties = { width, height };
  if (!userSize) {
    (panelStyle as Record<string, string | number>)["--prompt-max-h"] = `${promptMaxH}px`;
  }

  return (
    <div
      ref={panelRef}
      className="absolute z-40 overflow-hidden rounded-xl border border-border bg-card shadow-xl"
      data-floating-editor
      data-editor-zoom="1"
      // left / top / transform 由上方 useLayoutEffect 通过 ref imperative 设置
      style={panelStyle}
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
      {/* 未手动调整尺寸时,内容区为内容驱动高度(配合上方测量做自适应);手动调整后铺满面板
          (h-full),让文本框等 flex-1 区域填充用户拉出的空间。两种情况都在超高时内部滚动。 */}
      <div
        ref={contentRef}
        className={userSize ? "h-full overflow-auto" : "overflow-auto"}
        style={userSize ? undefined : { maxHeight: maxAutoHeight }}
      >
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
