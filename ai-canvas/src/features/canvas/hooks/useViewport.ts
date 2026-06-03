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

// 平移手势中累计未提交位移（世界像素）超过此阈值时提交一次 store：重建 CardLayer/
// ConnectionLayer 的可视集，在视口外的 overscan 余量里补满新卡/连线，赶在缓冲耗尽
// 出现边缘空白之前。其余时间平移零提交（冻结内层、纯 GPU 平移）。须 < 两层的
// VIEWPORT_MARGIN / CONN_VIEWPORT_MARGIN（世界像素），否则补帧晚于空白。
const PAN_REFILL_WORLD = 180;

export function useViewport(
  containerRef: React.RefObject<HTMLDivElement | null>,
) {
  const setViewport = useCanvasStore((s) => s.setViewport);
  const viewport = useCanvasStore((s) => s.viewport);
  const panning = useRef(false);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  const panLast = useRef({ x: 0, y: 0 });
  const wheelCommitTimer = useRef(0);
  const interactingTimer = useRef(0);
  const pendingWheel = useRef<{ x: number; y: number; zoom: number } | null>(null);
  // 平移手势起点缓存的容器 rect：手势中复用，避免每帧 getBoundingClientRect 触发
  // 强制同步 layout（与样式写入交错 → layout thrash）。
  const rectRef = useRef<DOMRect | null>(null);
  // 上次向 store 提交的平移位置（screen 坐标），用于按位移阈值补帧。
  const lastCommit = useRef({ x: 0, y: 0 });
  // >0 表示「缩放手势进行中」，值为内层栅格化基准 scale（手势起点 zoom）。
  // 0 = 不在缩放手势中（zoom 恒 >0，用 0 当哨兵安全）。
  const gestureRenderZoom = useRef(0);

  // CSS 变量挂在 container 上：背景层在 birdview 切换时会被卸载/重新挂载，
  // container 一直存在，子层用 var() 引用自动恢复正确位置。
  const getRoot = useCallback(() => containerRef.current, [containerRef]);

  // 刷新容器 rect 缓存（手势起点 / resize 时调用）。
  const refreshRect = useCallback(() => {
    rectRef.current = containerRef.current?.getBoundingClientRect() ?? null;
  }, [containerRef]);

  // 平移补帧/收尾的统一提交：把当前实时位置提交进 store（触发一次可视集重建），
  // 并记录提交点用于下次位移阈值判断。
  const commitPan = useCallback(() => {
    setViewport({ x: panLast.current.x, y: panLast.current.y });
    lastCommit.current = { x: panLast.current.x, y: panLast.current.y };
  }, [setViewport]);

  // 手势期间（滚轮缩放 / 拖拽平移）给容器加 .canvas-interacting，CSS 借此暂停
  // 画布内常驻动画（连线流光、选中描边流动等），让内层纹理可缓存。纯 classList 操作，
  // 不触发 React 重渲染；停手 ~180ms 后自动移除恢复动画。
  // mode === "zoom" 额外加 .canvas-zooming（CSS 据此挂 will-change）：缩放需把内层
  // 栅格化为静态纹理交给外层 GPU 缩放，故两层都要提升；平移靠外层 translate3d 本就是
  // 合成层、无需 will-change，且给指针悬停层挂 will-change 会在 WebView2 触发
  // “合成层上方不绘制光标”缺陷（拖动时鼠标消失），故平移**不**加。
  const markInteracting = useCallback(
    (mode: "pan" | "zoom") => {
      const root = getRoot();
      if (root) {
        root.classList.add("canvas-interacting");
        root.classList.toggle("canvas-zooming", mode === "zoom");
      }
      if (interactingTimer.current) clearTimeout(interactingTimer.current);
      interactingTimer.current = window.setTimeout(() => {
        interactingTimer.current = 0;
        const r = getRoot();
        if (r) {
          r.classList.remove("canvas-interacting");
          r.classList.remove("canvas-zooming");
        }
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
        } else if (panning.current) {
          // 平移中途停顿 ≥180ms：提交一次当前位置，重建可视集补满 overscan 缓冲。
          commitPan();
        }
      }, 180);
    },
    [getRoot, setViewport, commitPan],
  );

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
    } else if (panning.current) {
      // 平移补帧提交会让 store 落后于实时 panLast；DOM 跟实时值，避免回拨抖动。
      applyViewportToDOM(getRoot(), panLast.current.x, panLast.current.y, viewport.zoom);
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
      rectRef.current = el.getBoundingClientRect();
      setViewport({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef, setViewport]);

  useEffect(() => {
    return () => {
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
      // 滚轮连发期间复用手势起点 rect（interactingTimer 在跑即手势进行中），
      // 避免每个 wheel 事件都 getBoundingClientRect。
      if (!interactingTimer.current) refreshRect();
      const rect = rectRef.current;
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
      markInteracting(isZoom ? "zoom" : "pan");
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
    [getRoot, scheduleWheelCommit, markInteracting, refreshRect],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button === 1) {
        panning.current = true;
        setIsPanning(true);
        const vp = useCanvasStore.getState().viewport;
        panStart.current = { x: e.clientX, y: e.clientY, vx: vp.x, vy: vp.y };
        panLast.current = { x: vp.x, y: vp.y };
        lastCommit.current = { x: vp.x, y: vp.y };
        refreshRect();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    },
    [refreshRect],
  );

  const startPan = useCallback(
    (clientX: number, clientY: number) => {
      panning.current = true;
      setIsPanning(true);
      const vp = useCanvasStore.getState().viewport;
      panStart.current = { x: clientX, y: clientY, vx: vp.x, vy: vp.y };
      panLast.current = { x: vp.x, y: vp.y };
      lastCommit.current = { x: vp.x, y: vp.y };
      refreshRect();
    },
    [refreshRect],
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
      markInteracting("pan");

      // 根治平移卡顿（与缩放对称，见 CLAUDE.md 视口契约 #8）：手势进行中**不**按时间
      // 持续提交 store。每次提交都让 CardLayer/ConnectionLayer 在被合成的内层增删 DOM
      // → 作废纹理整屏重栅 → 周期性卡顿。改为仅当未提交位移（世界像素）超过 overscan
      // 余量阈值时提交一次补帧（新卡都落在视口外 margin 里，用户看不到“弹出”、也不空白），
      // 其余时间零提交、纯 GPU 平移。停顿 / 抬指各再提交一次（见 markInteracting / onPointerUp）。
      const movedWorld =
        Math.hypot(newX - lastCommit.current.x, newY - lastCommit.current.y) / zoom;
      if (movedWorld >= PAN_REFILL_WORLD) {
        commitPan();
      }
    },
    [getRoot, markInteracting, commitPan],
  );

  const onPointerUp = useCallback(() => {
    if (panning.current) {
      commitPan();
    }
    panning.current = false;
    setIsPanning(false);
  }, [commitPan]);

  const screenToCanvas = useCallback(
    (clientX: number, clientY: number) => {
      // 平移中复用手势起点缓存的 rect，避免 pointermove 每帧 getBoundingClientRect
      // 与样式写入交错触发强制同步 layout；空闲（悬停）时实时取，保证精确。
      const rect = panning.current
        ? (rectRef.current ?? containerRef.current?.getBoundingClientRect())
        : containerRef.current?.getBoundingClientRect();
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
