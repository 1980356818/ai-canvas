import { useEffect, useCallback, useRef, useState } from "react";
import { useCanvasStore } from "@/stores/canvasStore";

function applyViewportToDOM(
  container: HTMLDivElement,
  x: number,
  y: number,
  zoom: number,
) {
  const bg = container.querySelector(
    "[data-canvas-background]",
  ) as HTMLElement | null;
  if (bg) bg.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
  container.style.backgroundSize = `${20 * zoom}px ${20 * zoom}px`;
  container.style.backgroundPosition = `${x}px ${y}px`;
}

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
  const wheelRaf = useRef(0);

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

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const vp = useCanvasStore.getState().viewport;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;

      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const newZoom = Math.min(5, Math.max(0.1, vp.zoom * factor));
      const ratio = newZoom / vp.zoom;
      const newX = cursorX - (cursorX - vp.x) * ratio;
      const newY = cursorY - (cursorY - vp.y) * ratio;

      if (containerRef.current) {
        applyViewportToDOM(containerRef.current, newX, newY, newZoom);
      }

      if (wheelRaf.current) cancelAnimationFrame(wheelRaf.current);
      wheelRaf.current = requestAnimationFrame(() => {
        wheelRaf.current = 0;
        setViewport({ zoom: newZoom, x: newX, y: newY });
      });
    },
    [containerRef, setViewport],
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

      const container = containerRef.current;
      if (container) {
        const zoom = useCanvasStore.getState().viewport.zoom;
        applyViewportToDOM(container, newX, newY, zoom);
      }

      if (!panCommitTimer.current) {
        panCommitTimer.current = window.setTimeout(() => {
          panCommitTimer.current = 0;
          if (panning.current) {
            setViewport({ x: panLast.current.x, y: panLast.current.y });
          }
        }, 150);
      }
    },
    [containerRef, setViewport],
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
