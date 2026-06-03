import { useEffect, useLayoutEffect, useCallback, useRef, useState } from "react";
import {
  useCanvasStore,
  liveViewport,
  notifyViewportChanged,
} from "@/stores/canvasStore";
import { MIN_ZOOM, MAX_ZOOM } from "@/shared/constants";

// 通过 CSS 变量驱动画布两层 transform（见 CanvasContainer 的 vp-pan-layer /
// vp-render-layer）。React 渲染的 transform 字符串永不变化，避免 commit 打破 GPU 合成层。
//
//   外层 pan  ：translate3d(--vp-x, --vp-y, 0) scale(--vp-gpu)   ← GPU 视觉缩放
//   内层 render：scale(--vp-render)                              ← 内容栅格化基准
//   实际缩放 = --vp-gpu × --vp-render
//
// 静止/提交态：render = zoom，gpu = 1（内容按正确分辨率栅格化 → 清晰）。
// 缩放手势中：render 冻结为手势起点 zoom，gpu = zoom / render（只有外层 scale 变，
//   浏览器用 GPU 直接缩放下面已栅格化的内层纹理，**不重栅格化** → 丝滑；放大时暂时偏软）。
//   停手后提交 render = zoom、gpu = 1，重栅格化一次恢复清晰。
// 同时同步 liveViewport + 通知订阅者，让浮层组件跟上 60fps 的 imperative 更新。
function applyViewportToDOM(container: HTMLElement | null, x: number, y: number, zoom: number) {
  liveViewport.x = x;
  liveViewport.y = y;
  liveViewport.zoom = zoom;
  if (container) {
    const s = container.style;
    s.setProperty("--vp-x", `${x}px`);
    s.setProperty("--vp-y", `${y}px`);
    s.setProperty("--vp-render", String(zoom));
    s.setProperty("--vp-gpu", "1");
  }
  notifyViewportChanged();
}

// 缩放手势态：内层 render 冻结（renderZoom 不写），外层 gpu 吸收缩放比，
// 浏览器 GPU 缩放已栅格化的内层纹理而非重栅格化。
function applyViewportZoomGesture(
  container: HTMLElement | null,
  x: number,
  y: number,
  zoom: number,
  renderZoom: number,
) {
  liveViewport.x = x;
  liveViewport.y = y;
  liveViewport.zoom = zoom;
  if (container) {
    const s = container.style;
    s.setProperty("--vp-x", `${x}px`);
    s.setProperty("--vp-y", `${y}px`);
    s.setProperty("--vp-gpu", String(zoom / renderZoom));
    // 不写 --vp-render：保持冻结，内层纹理复用
  }
  notifyViewportChanged();
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
  const interactingTimer = useRef(0);
  const pendingWheel = useRef<{ x: number; y: number; zoom: number } | null>(null);
  // >0 表示「缩放手势进行中」，值为内层栅格化基准 scale（手势起点 zoom）。
  // 0 = 不在缩放手势中（zoom 恒 >0，用 0 当哨兵安全）。
  const gestureRenderZoom = useRef(0);

  // CSS 变量挂在 container 上：背景层在 birdview 切换时会被卸载/重新挂载，
  // container 一直存在，子层用 var() 引用自动恢复正确位置。
  const getRoot = useCallback(() => containerRef.current, [containerRef]);

  // 手势期间（滚轮缩放 / 拖拽平移）给容器加 .canvas-interacting，CSS 借此暂停
  // 画布内常驻动画（连线流光、选中描边流动等）。这些动画每帧都让 SVG/卡片层变脏，
  // 缩放时与「按新 scale 重栅格化」叠加 → 抖动。纯 classList 操作，不触发 React
  // 重渲染；停手 ~180ms 后自动移除恢复动画。
  const markInteracting = useCallback(() => {
    const root = getRoot();
    if (root) root.classList.add("canvas-interacting");
    if (interactingTimer.current) clearTimeout(interactingTimer.current);
    interactingTimer.current = window.setTimeout(() => {
      interactingTimer.current = 0;
      getRoot()?.classList.remove("canvas-interacting");
      // 结束缩放手势：把冻结的 render 提交为真实 zoom（gpu 归 1），
      // 触发一次重栅格化恢复清晰。flush 掉未提交的滚轮中间态。
      if (gestureRenderZoom.current > 0) {
        gestureRenderZoom.current = 0;
        if (wheelCommitTimer.current) {
          clearTimeout(wheelCommitTimer.current);
          wheelCommitTimer.current = 0;
        }
        const p = pendingWheel.current;
        if (p) {
          pendingWheel.current = null;
          setViewport(p); // → layoutEffect(g=0) → applyViewportToDOM 清晰
        } else {
          applyViewportToDOM(getRoot(), liveViewport.x, liveViewport.y, liveViewport.zoom);
        }
      }
    }, 180);
  }, [getRoot, setViewport]);

  // store viewport 变化时同步写一次 CSS 变量。覆盖以下场景：
  //   - 挂载 / 项目切换的初始 viewport
  //   - fitAll / zoomTo 等 imperative 修改
  //   - 拖拽/滚轮节流提交后保持 DOM 与 store 一致
  useLayoutEffect(() => {
    // 缩放手势中 store 每 80ms 提交也会走到这里——必须保持 render 冻结，否则
    // 每次提交都重栅格化，前功尽弃。手势结束后（gestureRenderZoom=0）才写清晰态。
    if (gestureRenderZoom.current > 0) {
      applyViewportZoomGesture(
        getRoot(),
        viewport.x,
        viewport.y,
        viewport.zoom,
        gestureRenderZoom.current,
      );
    } else {
      applyViewportToDOM(getRoot(), viewport.x, viewport.y, viewport.zoom);
    }
  }, [viewport.x, viewport.y, viewport.zoom, getRoot]);

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
      if (interactingTimer.current) clearTimeout(interactingTimer.current);
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
      let isZoom = false;

      if (e.ctrlKey || e.metaKey) {
        // Pinch-to-zoom (Mac trackpad) or Ctrl+scroll (Windows/Linux)
        isZoom = true;
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
          isZoom = true;
          const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
          newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, base.zoom * factor));
          const ratio = newZoom / base.zoom;
          newX = cursorX - (cursorX - base.x) * ratio;
          newY = cursorY - (cursorY - base.y) * ratio;
        }
      }

      // 进入缩放手势：锁定内层栅格化基准为手势起点 zoom（base.zoom，第一次进入时
      // base 即 store 真实 zoom），后续滚轮不再改它，由 gpu 吸收缩放比。
      if (gestureRenderZoom.current === 0) {
        gestureRenderZoom.current = base.zoom;
      }
      pendingWheel.current = { x: newX, y: newY, zoom: newZoom };
      // 缩放偏离栅格化基准超过 2× 时，重设基准并重栅格化一次：把手势中的模糊限制在
      // ≤2×（否则一路放大到 5× 时纹理会越来越糊）。这种重栅至多每翻倍发生一次，
      // 仍远少于「每帧重栅」；其余帧走 GPU 缩放纹理，丝滑。
      const ratioToBase = newZoom / gestureRenderZoom.current;
      if (ratioToBase > 2 || ratioToBase < 0.5) {
        gestureRenderZoom.current = newZoom;
        applyViewportToDOM(getRoot(), newX, newY, newZoom);
      } else {
        applyViewportZoomGesture(getRoot(), newX, newY, newZoom, gestureRenderZoom.current);
      }
      markInteracting();
      // 彻底根治缩放卡顿（硬规则，见 CLAUDE.md 视口契约 #8）：
      // 缩放手势中绝不提交 store viewport。每次提交都会让 CardLayer/ConnectionLayer
      // 重算可视集，在冻结的内层(vp-render-layer)里增删 DOM → 合成纹理作废、整屏重栅
      // → 每秒十余次卡顿尖峰（实测对照：保留提交 p99≈50ms，去掉后 p99≈33ms、零尖峰）。
      // 缩放最终态由 markInteracting 停手 ~180ms 后 flush 一次提交、重栅一次恢复清晰。
      // 平移(trackpad)需边移边露出新卡，保留 80ms 节流提交。
      if (isZoom) {
        // 清掉可能残留的待提交（先平移后缩放的混合手势），避免缩放途中被一次提交打断
        if (wheelCommitTimer.current) {
          clearTimeout(wheelCommitTimer.current);
          wheelCommitTimer.current = 0;
        }
      } else {
        scheduleWheelCommit();
      }
    },
    [containerRef, getRoot, scheduleWheelCommit, markInteracting],
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
      // 鼠标拖拽平移：zoom 不变，走清晰态（render=zoom, gpu=1）。外层 translate3d
      // 平移本就走 GPU、不重栅格化，无需 render 冻结；显式复位缩放手势态。
      gestureRenderZoom.current = 0;
      applyViewportToDOM(getRoot(), newX, newY, zoom);
      markInteracting();

      if (!panCommitTimer.current) {
        panCommitTimer.current = window.setTimeout(() => {
          panCommitTimer.current = 0;
          if (panning.current) {
            setViewport({ x: panLast.current.x, y: panLast.current.y });
          }
        }, 150);
      }
    },
    [getRoot, setViewport, markInteracting],
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
