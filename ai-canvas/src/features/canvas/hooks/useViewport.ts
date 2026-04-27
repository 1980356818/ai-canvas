import { useEffect, useCallback, useRef, useState } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { MIN_ZOOM, MAX_ZOOM } from "@/shared/constants";

// 直接更新 DOM transform，绕开 React 渲染。translate3d 提示浏览器使用 GPU 合成层。
function applyViewportToDOM(bg: HTMLElement | null, x: number, y: number, zoom: number) {
  if (bg) bg.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${zoom})`;
}

// 视图状态提交节流（ms）。期间 DOM 已经被实时更新，只是把 React store 的状态延迟提交，
// 避免 60fps 触发整个画布树重渲染。
const VIEWPORT_COMMIT_DELAY = 80;

export function useViewport(
  containerRef: React.RefObject<HTMLDivElement | null>,
) {
  const setViewport = useCanvasStore((s) => s.setViewport);
  const viewport = useCanvasStore((s) => s.viewport);
  const panning = useRef(false);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  const panLast = useRef({ x: 0, y: 0 });
  const panCommitTimer = useRef(0);
  const wheelCommitTimer = useRef(0);
  const pendingWheel = useRef<{ x: number; y: number; zoom: number } | null>(null);
  const cachedBg = useRef<HTMLElement | null>(null);

  // birdview 切换时背景层会重新挂载，所以失效时重新查
  const getBgEl = useCallback(() => {
    const cached = cachedBg.current;
    if (cached && cached.isConnected) return cached;
    const fresh = containerRef.current?.querySelector(
      "[data-canvas-background]",
    ) as HTMLElement | null;
    cachedBg.current = fresh;
    return fresh;
  }, [containerRef]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setViewport({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef, setViewport]);

  useEffect(() => {
    return () => {
      if (panCommitTimer.current) clearTimeout(panCommitTimer.current);
      if (wheelCommitTimer.current) clearTimeout(wheelCommitTimer.current);
    };
  }, []);

  // 滚轮：DOM 实时更新 + React 状态延迟提交（节流到 ~80ms）
  const scheduleWheelCommit = useCallback(() => {
    if (wheelCommitTimer.current) return;
    wheelCommitTimer.current = window.setTimeout(() => {
      wheelCommitTimer.current = 0;
      const p = pendingWheel.current;
      if (p) {
        pendingWheel.current = null;
        setViewport(p);
      }
    }, VIEWPORT_COMMIT_DELAY);
  }, [setViewport]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      // 用 pendingWheel 当前值优先（连续滚轮事件的中间状态），其次用 store 当前值
      const base = pendingWheel.current ?? useCanvasStore.getState().viewport;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;

      let newX = base.x;
      let newY = base.y;
      let newZoom = base.zoom;

      if (e.ctrlKey || e.metaKey) {
        // Pinch-to-zoom (Mac trackpad) or Ctrl+scroll (Windows/Linux)
        const delta = -e.deltaY * 0.005;
        const factor = Math.exp(delta);
        newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, base.zoom * factor));
        const ratio = newZoom / base.zoom;
        newX = cursorX - (cursorX - base.x) * ratio;
        newY = cursorY - (cursorY - base.y) * ratio;
      } else {
        const isPrecise = Math.abs(e.deltaY) < 50 && e.deltaMode === 0;
        if (isPrecise) {
          // Trackpad: pan canvas
          newX = base.x - e.deltaX;
          newY = base.y - e.deltaY;
        } else {
          // Mouse wheel: zoom
          const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
          newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, base.zoom * factor));
          const ratio = newZoom / base.zoom;
          newX = cursorX - (cursorX - base.x) * ratio;
          newY = cursorY - (cursorY - base.y) * ratio;
        }
      }

      pendingWheel.current = { x: newX, y: newY, zoom: newZoom };
      applyViewportToDOM(getBgEl(), newX, newY, newZoom);
      scheduleWheelCommit();
    },
    [containerRef, getBgEl, scheduleWheelCommit],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button === 1) {
        panning.current = true;
        setIsPanning(true);
        const vp = useCanvasStore.getState().viewport;
        panStart.current = { x: e.clientX, y: e.clientY, vx: vp.x, vy: vp.y };
        panLast.current = { x: vp.x, y: vp.y };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    },
    [],
  );

  const startPan = useCallback(
    (clientX: number, clientY: number) => {
      panning.current = true;
      setIsPanning(true);
      const vp = useCanvasStore.getState().viewport;
      panStart.current = { x: clientX, y: clientY, vx: vp.x, vy: vp.y };
      panLast.current = { x: vp.x, y: vp.y };
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!panning.current) return;
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      const newX = panStart.current.vx + dx;
      const newY = panStart.current.vy + dy;
      panLast.current = { x: newX, y: newY };

      const zoom = useCanvasStore.getState().viewport.zoom;
      applyViewportToDOM(getBgEl(), newX, newY, zoom);

      if (!panCommitTimer.current) {
        panCommitTimer.current = window.setTimeout(() => {
          panCommitTimer.current = 0;
          if (panning.current) {
            setViewport({ x: panLast.current.x, y: panLast.current.y });
          }
        }, 150);
      }
    },
    [getBgEl, setViewport],
  );

  const onPointerUp = useCallback(() => {
    if (panning.current) {
      if (panCommitTimer.current) {
        clearTimeout(panCommitTimer.current);
        panCommitTimer.current = 0;
      }
      setViewport({ x: panLast.current.x, y: panLast.current.y });
    }
    panning.current = false;
    setIsPanning(false);
  }, [setViewport]);

  const screenToCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      const vp = useCanvasStore.getState().viewport;
      const vpX = panning.current ? panLast.current.x : vp.x;
      const vpY = panning.current ? panLast.current.y : vp.y;
      return {
        x: (clientX - rect.left - vpX) / vp.zoom,
        y: (clientY - rect.top - vpY) / vp.zoom,
      };
    },
    [containerRef],
  );

  return {
    viewport,
    isPanning,
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    startPan,
    screenToCanvas,
  };
}
