import { useEffect, useCallback, useRef } from "react";
import { useCanvasStore } from "@/stores/canvasStore";

export function useViewport(
  containerRef: React.RefObject<HTMLDivElement | null>,
) {
  const setViewport = useCanvasStore((s) => s.setViewport);
  const viewport = useCanvasStore((s) => s.viewport);
  const spaceHeld = useRef(false);
  const panning = useRef(false);
  const panStart = useRef({ x: 0, y: 0, vx: 0, vy: 0 });

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
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat) spaceHeld.current = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceHeld.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

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

      setViewport({
        zoom: newZoom,
        x: cursorX - (cursorX - vp.x) * ratio,
        y: cursorY - (cursorY - vp.y) * ratio,
      });
    },
    [containerRef, setViewport],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button === 1 || (e.button === 0 && spaceHeld.current)) {
        panning.current = true;
        const vp = useCanvasStore.getState().viewport;
        panStart.current = { x: e.clientX, y: e.clientY, vx: vp.x, vy: vp.y };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!panning.current) return;
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      setViewport({
        x: panStart.current.vx + dx,
        y: panStart.current.vy + dy,
      });
    },
    [setViewport],
  );

  const onPointerUp = useCallback(() => {
    panning.current = false;
  }, []);

  const screenToCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      const vp = useCanvasStore.getState().viewport;
      return {
        x: (clientX - rect.left - vp.x) / vp.zoom,
        y: (clientY - rect.top - vp.y) / vp.zoom,
      };
    },
    [containerRef],
  );

  return {
    viewport,
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    screenToCanvas,
  };
}
