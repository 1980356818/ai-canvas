import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import {
  Film,
  ChevronDown,
  Download,
  HardDriveDownload,
  Loader2,
  Link2,
  Crosshair,
  Image as ImageIcon,
} from "lucide-react";
import { useCanvasStore, liveViewport, subscribeViewport } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
// persistImage 名字虽叫 image,但内部走 saveMedia 对任意媒体源 (含 HTTP 视频 URL) 都通用,
// 远程视频→本地落盘走这条路径无需新增 API。
import { persistImage, exportFile, getDisplayUrl } from "@/lib/media";
import { autoSave } from "@/lib/autoSave";
import { cn } from "@/lib/utils";
import {
  extractFramesFromVideo,
  extractFrameAtTimestamp,
  continueShotFromVideo,
  canContinueShot,
  isVeoReferenceMode,
  probeDuration,
  type ExtractMode,
  type ExtractTarget,
} from "@/lib/videoOps";
import { generateVideoThumbnails } from "@/lib/videoThumbnails";

// ── 功能可见性开关 (产品裁剪) ────────────────────────────────────────
// 暂时下线这些视频卡 UI 入口,只保留「等间隔 N 秒」抽帧 (无帧数上限)。底层实现
// (videoOps 的 scene/firstLast/续拍/拖帧 函数、TimelineScrubber 组件) 全部保留,
// 未来恢复某项把对应开关改回 true 即可。
const VIDEO_FEATURES: Record<string, boolean> = {
  sceneExtract: false,     // 抽帧下拉: 智能关键帧 (智能分镜)
  firstLastExtract: false, // 抽帧下拉: 首尾帧
  dragFrame: false,        // 拖帧 (timeline scrubber 挑帧拖出)
  continueShot: false,     // 续拍 (尾帧 → 新视频卡首帧)
};

const TOOLBAR_GAP = 10;
// 拖帧焦点模式下, scrubber 钉在视频卡 *下方* (FloatingEditor 此时被 store 切换
// 强制收起, 让出位置). 这是剪辑软件的标准布局: 时间轴在画面下方, 眼睛流自然。
// 卡下方 6px 留白 → scrubber 主体 (缩略图条 + 刻度), 6px → FrameChip 浮窗。
const SCRUBBER_GAP = 6;
const THUMBSTRIP_HEIGHT = 64;
const TICKS_HEIGHT = 16;
const SCRUBBER_TOTAL_HEIGHT = THUMBSTRIP_HEIGHT + TICKS_HEIGHT;
const MIN_SCRUBBER_WIDTH = 800;
const THUMBNAIL_COUNT = 12;

interface VideoData {
  videoUrl?: string;
  content?: string;
  model?: string;
  imageMode?: string;
}

function screenToCanvas(clientX: number, clientY: number) {
  const container = document.querySelector("[data-canvas-viewport]");
  const rect = container?.getBoundingClientRect();
  const vp = useCanvasStore.getState().viewport;
  const x = rect ? clientX - rect.left : clientX;
  const y = rect ? clientY - rect.top : clientY;
  return {
    x: (x - vp.x) / vp.zoom,
    y: (y - vp.y) / vp.zoom,
  };
}

// ── 抽帧策略下拉 ──────────────────────────────────────────────────────

interface ExtractMenuProps {
  open: boolean;
  onClose: () => void;
  onChoose: (mode: ExtractMode) => void;
}

const INTERVAL_OPTIONS = [
  { value: 0.5, label: "0.5s" },
  { value: 1, label: "1s" },
  { value: 2, label: "2s" },
  { value: 5, label: "5s" },
];

function ExtractMenu({ open, onClose, onChoose }: ExtractMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [intervalOpen, setIntervalOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full z-50 mt-1 min-w-[180px] rounded-lg border border-border bg-popover p-1 shadow-lg"
    >
      {VIDEO_FEATURES.sceneExtract && (
        <button
          className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground"
          onClick={() => { onChoose({ kind: "scene", threshold: 0.4 }); onClose(); }}
          title="ffmpeg 场景检测 → 每个镜头切点出一张图"
        >
          <Crosshair className="h-3.5 w-3.5 text-emerald-500" />
          <span className="flex-1">智能关键帧</span>
        </button>
      )}

      <div className="relative">
        <button
          className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground"
          onClick={() => setIntervalOpen((v) => !v)}
        >
          <Film className="h-3.5 w-3.5 text-sky-500" />
          <span className="flex-1">等间隔 N 秒</span>
          <ChevronDown className="h-3 w-3" />
        </button>
        {intervalOpen && (
          <div className="absolute left-full top-0 ml-1 min-w-[100px] rounded-lg border border-border bg-popover p-1 shadow-lg">
            {INTERVAL_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                className="block w-full rounded-md px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent"
                onClick={() => { onChoose({ kind: "interval", stepSec: value }); onClose(); }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {VIDEO_FEATURES.firstLastExtract && (
        <button
          className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground"
          onClick={() => { onChoose({ kind: "firstLast" }); onClose(); }}
          title="首帧 + 尾帧 (适合接「首尾帧生视频」)"
        >
          <ImageIcon className="h-3.5 w-3.5 text-amber-500" />
          <span className="flex-1">首尾帧</span>
        </button>
      )}
    </div>
  );
}

// ── 时间轴 scrubber + 拖到画布抽帧 ────────────────────────────────────
//
// 与 ImageToolbar 的宫格拖拽保持同样的"按下 → 浮动框跟手 → 释放出新卡"语义。
// 但 video 不是空间网格而是时间轴, 所以 hover 时显示时间戳, 释放时把当前
// scrubber 时间 + 鼠标屏幕位置传给 videoOps。
//
// 高频更新 (浮动框 / 时间标签) 走 imperative 不参与 React 渲染, 避免 viewport
// 同步抖动。设计动机与 ImageToolbar.GridOverlay 一致。

interface ScrubberProps {
  cardId: string;
  target: ExtractTarget;
  duration: number | null;
  onClose: () => void;
}

function TimelineScrubber({ cardId, target, duration, onClose }: ScrubberProps) {
  const scrubberRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // hoverTs: 仅用来画"如果点这里 playhead 会跳到的位置"的虚线提示, 不动 playhead 本体
  const [hoverTs, setHoverTs] = useState<number | null>(null);
  // playheadTs: 持久的播放头位置 — 这是用户"挑中的那一帧". 按下/拖动/释放才会动,
  // hover 不会动. 视频元素的 currentTime 直接绑到这个值。
  const [playheadTs, setPlayheadTs] = useState<number>(0);
  const draggingTsRef = useRef<number>(0);
  // 缩略图条 — 一次性 batch 生成 N 张, 当 background 渲染。
  // 用 state 而不是 ref 是因为需要触发 React render 来把 thumbs 涂到 DOM。
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [thumbsLoading, setThumbsLoading] = useState(true);

  // ── 视频元素 seek 联动 ───────────────────────────────────────────
  //
  // 直接拿到视频卡里的 <video> DOM, hover/drag scrubber 时 videoEl.currentTime
  // 实时跟到鼠标位置 → 用户看到的就是真实那一帧, 而不是干拖一个进度条盲选。
  //
  // - 卡片用 preload="none" 省内存, scrubber 一打开就要能 seek, 所以强制
  //   切到 preload="auto" + 主动 load(). 关闭 scrubber 不还原 (用户可能想接着看).
  // - currentTime 写入用 rAF 合帧, 避免 60fps pointermove 把 video pipeline 灌爆.
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const seekRafRef = useRef<number>(0);

  useEffect(() => {
    const el = document.querySelector(
      `[data-card-id="${cardId}"] video`,
    ) as HTMLVideoElement | null;
    if (!el) return;
    videoElRef.current = el;
    // 视频卡默认 preload="none", scrubber 打开后必须能 seek, 抬一档.
    //
    // ⚠️ 关键: 只在 readyState < HAVE_METADATA 时调 load(). 不然 load() 会把
    // currentTime 强行重置到 0 + 丢掉已缓冲的数据 — 用户点的位置立刻被冲掉
    // (这就是"点击时间轴红光标一直在最左"的 root cause)。
    if (el.preload !== "auto") {
      el.preload = "auto";
      if (el.readyState < 1 /* HAVE_METADATA */) {
        try { el.load(); } catch { /* ignore */ }
      }
    }
    try { el.pause(); } catch { /* ignore */ }
    // 初始化 playhead 到视频当前时间 — 用户上次留在哪一帧 / 没动过就是 0,
    // metadata 没就绪时 currentTime 也是 0, 不会乱跳。
    if (Number.isFinite(el.currentTime)) {
      setPlayheadTs(el.currentTime);
    }

    // 监听用户用 <video controls> 原生进度条手动 seek — 我们的 playhead 要跟着动。
    //
    // ⚠️ 守卫**必须**用 ref 而不是闭包变量 `dragging`: 若把 dragging 进 effect deps,
    // 整个 effect 会在每次拖动开始/结束时重跑, 触发上面的 setPlayheadTs(el.currentTime)
    // 覆盖用户刚 commit 的 playhead — 红光标永远跳回 0。
    const onSeeked = () => {
      if (draggingTsRef.current !== 0) return; // 拖动期间, 任何 seeked 都是我们自己引发的, 忽略
      if (Number.isFinite(el.currentTime)) {
        setPlayheadTs(el.currentTime);
      }
    };
    el.addEventListener("seeked", onSeeked);

    return () => {
      if (seekRafRef.current) cancelAnimationFrame(seekRafRef.current);
      el.removeEventListener("seeked", onSeeked);
      videoElRef.current = null;
    };
    // 故意只依赖 cardId — dragging 进 deps 会引发 load() 灾难, 见上面 ⚠️。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId]);

  const seekVideo = useCallback((ts: number) => {
    pendingSeekRef.current = ts;
    if (seekRafRef.current) return;
    seekRafRef.current = requestAnimationFrame(() => {
      seekRafRef.current = 0;
      const ts = pendingSeekRef.current;
      const el = videoElRef.current;
      if (el && ts != null && Number.isFinite(ts)) {
        try { el.currentTime = ts; } catch { /* ignore */ }
      }
    });
  }, []);

  // ── Playhead DOM 同步 ──────────────────────────────────────────
  //
  // playhead 的 left + 时间标签都走 ref imperative 设, JSX 不写 inline 值,
  // 这样拖动期间 head.style.left = `${pct}%` 不会被任何无关 React re-render 清掉.
  // 当 playheadTs / duration 任一变化时, 这个 effect 把 DOM 同步回 state.
  useLayoutEffect(() => {
    const head = headRef.current;
    const lbl = labelRef.current;
    if (!duration) return;
    const pct = (playheadTs / duration) * 100;
    if (head) head.style.left = `${pct}%`;
    if (lbl) lbl.textContent = formatTs(playheadTs);
  }, [playheadTs, duration]);

  // ── 键盘快捷键 ────────────────────────────────────────────────
  //
  // Esc        退出拖帧模式
  // ← / →      步进 playhead ±0.1s
  // Shift+← →  步进 ±1s
  //
  // 输入框聚焦时不拦截 (避免影响 prompt 编辑) — 但拖帧模式下 editor 已经关掉,
  // 一般也没活跃输入框, 这里只是稳妥兜底。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const inInput =
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable);
      if (inInput) return;

      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (!duration) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 0.1;
        const delta = e.key === "ArrowLeft" ? -step : step;
        const next = Math.max(0, Math.min(duration, playheadTs + delta));
        setPlayheadTs(next);
        seekVideo(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [duration, playheadTs, seekVideo, onClose]);

  // ── 缩略图条 batch 生成 ─────────────────────────────────────────
  //
  // 在独立 offscreen <video> 元素串行 seek + capture, 不干扰用户主视频卡。
  // 走 displayUrl (asset:// 或 https://) — Tauri 本地资源天然能 draw 进 canvas,
  // 远程 URL 没 CORS 头会 taint 整个 canvas → thumbs 数组返空, UI 退化成纯进度条。
  useEffect(() => {
    let cancelled = false;
    setThumbs([]);
    setThumbsLoading(true);
    const src = getDisplayUrl(target.videoUrl);
    void generateVideoThumbnails(src, THUMBNAIL_COUNT, { maxWidth: 200 }).then((result) => {
      if (cancelled) return;
      setThumbs(result.thumbs);
      setThumbsLoading(false);
    });
    return () => { cancelled = true; };
  }, [target.videoUrl]);

  // 跟随卡片位置 — scrubber 钉在工具栏上方 (即视频卡顶上方的安全区), 避免和
  // FloatingEditor (card_bottom + 12px) 抢同一带空间。
  useLayoutEffect(() => {
    let rafId = 0;
    let scheduled = false;

    const sync = () => {
      scheduled = false;
      const c = useCardStore.getState().cards.get(cardId);
      if (!c) return;
      const vp = liveViewport;
      const off = useCanvasStore.getState().dragOffsets.get(cardId);
      const offDx = off ? off.dx * vp.zoom : 0;
      const offDy = off ? off.dy * vp.zoom : 0;
      const left = c.x * vp.zoom + vp.x + offDx;
      const top = c.y * vp.zoom + vp.y + offDy;
      const width = c.width * vp.zoom;

      const el = scrubberRef.current;
      if (el) {
        // scrubber 宽 = max(最小可用宽, 卡片屏宽). 缩放画布时卡片屏宽自然随
        // vp.zoom 变, 但 MIN_SCRUBBER_WIDTH 把下限锁住 — 缩到 0.3x 的小卡上
        // scrubber 仍然有 800px, 不会被压成一个无法操作的小条。
        const scrubberW = Math.max(MIN_SCRUBBER_WIDTH, width);
        const cardCenterX = left + width / 2;
        el.style.left = `${cardCenterX - scrubberW / 2}px`;
        // 拖帧焦点模式: scrubber 钉在视频卡下方 (FloatingEditor 已被收起让位)。
        // 卡底 = top + height (= c.y * zoom + vp.y + c.height * zoom).
        const cardBottom = top + c.height * vp.zoom;
        el.style.top = `${cardBottom + SCRUBBER_GAP}px`;
        el.style.width = `${scrubberW}px`;
      }
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
  }, [cardId]);

  const computeTs = useCallback(
    (clientX: number): number => {
      const el = scrubberRef.current;
      if (!el || !duration) return 0;
      const rect = el.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return pct * duration;
    },
    [duration],
  );

  // 提交 playhead: 写 state + seek 视频. 用在 pointerdown / pointermove / pointerup 三处。
  // 不用 setState 后再 useEffect 触发 seek 是因为我们要 imperative 控制 video.currentTime,
  // 让用户拖动时画面"丝滑跟手"(rAF 合帧), 走 effect 会慢一拍并多一次 render。
  const commitPlayhead = useCallback(
    (ts: number) => {
      setPlayheadTs(ts);
      seekVideo(ts);
    },
    [seekVideo],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!duration) return;
      e.stopPropagation();
      e.preventDefault();
      const startTs = computeTs(e.clientX);
      draggingTsRef.current = startTs;
      setDragging(true);
      // 按下立刻把 playhead 跳到按下位置 + seek 视频 (剪辑软件标准: 单击 timeline 也定位)
      commitPlayhead(startTs);

      const onMove = (ev: PointerEvent) => {
        const ts = computeTs(ev.clientX);
        draggingTsRef.current = ts;
        // 拖动时 imperative 更新 playhead DOM (不走 setState 避免 60fps 重渲染),
        // 视频同步 seek。pointerup 时再用 setPlayheadTs 把 React state 一次性写入。
        seekVideo(ts);
        const head = headRef.current;
        const el = scrubberRef.current;
        if (head && el && duration) {
          const pct = (ts / duration) * 100;
          head.style.left = `${pct}%`;
        }
        const lbl = labelRef.current;
        if (lbl) lbl.textContent = formatTs(ts);
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);

        const blockClick = (ce: Event) => {
          ce.stopPropagation();
          ce.stopImmediatePropagation();
          ce.preventDefault();
        };
        window.addEventListener("click", blockClick, { capture: true, once: true });
        const cleanupTimer = setTimeout(
          () => window.removeEventListener("click", blockClick, { capture: true }),
          200,
        );

        // 释放: playhead 定格 (剪辑软件经典语义). 抽帧已经分离到 FrameChip 上,
        // scrubber 单纯负责"挑"。
        // 重要顺序: 先清 dragging ref + state, 再 setPlayheadTs — 否则上面 useEffect 里
        // onSeeked 的 dragging 守卫会把这次 commit 拦回去, 因为 seekVideo 触发的
        // seeked 事件可能在 setState 之前 deliver.
        const ts = draggingTsRef.current;
        draggingTsRef.current = 0;
        setDragging(false);
        setPlayheadTs(ts);
        void cleanupTimer;
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [computeTs, duration, target],
  );

  const handleHover = useCallback(
    (e: React.PointerEvent) => {
      if (dragging) return;
      // 只更新 hoverTs (画一条虚线 + 时间戳气泡, 提示用户"点这里 playhead 会跳到此处").
      // 不动 playhead、不 seek 视频 —— 剪辑软件 hover 不会乱跳画面, 必须按住才动.
      setHoverTs(computeTs(e.clientX));
    },
    [computeTs, dragging],
  );

  // 时间刻度: 短视频每 0.5s 一格, 中等每 1s, 长视频 (>15s) 每 2s 或 5s。
  // 控制密度避免标签互相挤压。
  const tickInterval = useMemo(() => {
    if (!duration) return 1;
    if (duration <= 4) return 0.5;
    if (duration <= 12) return 1;
    if (duration <= 30) return 2;
    return 5;
  }, [duration]);

  const ticks = useMemo(() => {
    if (!duration) return [];
    const out: number[] = [];
    for (let t = 0; t <= duration + 1e-3; t += tickInterval) {
      out.push(Math.min(t, duration));
    }
    return out;
  }, [duration, tickInterval]);

  return (
    <>
      <div
        ref={scrubberRef}
        className="absolute z-50 flex flex-col"
        style={{ height: `${SCRUBBER_TOTAL_HEIGHT}px` }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* === 缩略图条 (主交互区) === */}
        <div
          className="relative cursor-crosshair overflow-hidden rounded-md border border-border bg-card/95 shadow-md backdrop-blur-md"
          style={{ height: `${THUMBSTRIP_HEIGHT}px` }}
          onPointerMove={handleHover}
          onPointerLeave={() => setHoverTs(null)}
          onPointerDown={handlePointerDown}
          title={duration ? "在条上拖动看每一帧, 拖到画布空白处可抽这一帧到新图卡" : "正在读取视频…"}
        >
          {/* 缩略图网格 — N 张均匀分布的 dataURL 直接 backgroundImage, 不走 <img> 避免拖拽时浏览器原生 image-drag 抢事件 */}
          {thumbs.length > 0 ? (
            <div className="pointer-events-none absolute inset-0 flex">
              {thumbs.map((thumb, i) => (
                <div
                  key={i}
                  className="h-full border-r border-border/30 last:border-r-0"
                  style={{
                    flex: "1 1 0",
                    backgroundImage: `url(${thumb})`,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                  }}
                />
              ))}
            </div>
          ) : (
            // 退化态: thumbs 没生成出来 (生成中 / CORS 失败 / 视频解不动) → 显示纯色条 + 提示
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-muted/40 text-[10px] text-muted-foreground">
              {thumbsLoading ? "生成预览中…" : "无法生成缩略图"}
            </div>
          )}

          {/* 已播放进度遮罩 — 从 0 到 playhead 的半透明覆盖, 视觉上表达"已到这里" */}
          {duration && (
            <div
              className="pointer-events-none absolute inset-y-0 left-0 bg-primary/15"
              style={{ width: `${(playheadTs / duration) * 100}%` }}
            />
          )}

          {/* Hover 提示线 — 只在悬停未按下时显示, 虚线表示"如果点这里 playhead 会跳到此处".
              不动 playhead、不 seek 视频, 纯视觉。 */}
          {!dragging && hoverTs != null && duration && (
            <>
              <div
                className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-muted-foreground/50"
                style={{
                  left: `${(hoverTs / duration) * 100}%`,
                  backgroundImage:
                    "repeating-linear-gradient(to bottom, currentColor 0 3px, transparent 3px 6px)",
                }}
              />
              <div
                className="pointer-events-none absolute top-1 -translate-x-1/2 rounded bg-black/60 px-1 py-0.5 text-[9px] tabular-nums text-white/90"
                style={{ left: `${(hoverTs / duration) * 100}%` }}
              >
                {formatTs(hoverTs)}
              </div>
            </>
          )}

          {/* === Playhead 本体 === 持久可抓取的"播放头", 拖到哪定格到哪.
              位置走 useLayoutEffect 同步, JSX 不写 inline left — 这样拖动期间
              imperative 设的 head.style.left 不会被无关 re-render (例如 thumbsLoading 完成)
              清掉。 */}
          {duration && (
            <div
              ref={headRef}
              className="pointer-events-none absolute inset-y-0 z-[1] w-0.5 -translate-x-1/2 bg-red-500 shadow-[0_0_6px_rgba(0,0,0,0.6)]"
            >
              {/* 顶端抓取手柄 — 视觉上表达"这是可拖的物体" */}
              <div className="absolute -top-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rounded-sm bg-red-500 shadow-md ring-2 ring-white/90" />
              {/* 底端小三角 */}
              <div className="absolute -bottom-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-red-500" />
              {/* 当前时间标签 — 始终贴在 playhead 上, 用户一眼看到"我现在在第几秒".
                  text 也走 ref imperative 更新 (拖动 onMove 直接写 textContent), 拖完
                  pointerup 后由 useLayoutEffect 重新同步到 React state。 */}
              <div
                ref={labelRef}
                className="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-red-500 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white shadow"
              />
            </div>
          )}

          {/* 收起按钮 (右上角浮一个小 x) */}
          <button
            className="pointer-events-auto absolute right-1 top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white shadow transition-colors hover:bg-black/80"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            title="收起时间轴"
          >
            <span className="text-[12px] leading-none">×</span>
          </button>
        </div>

        {/* === 时间刻度尺 === */}
        <div
          className="relative shrink-0"
          style={{ height: `${TICKS_HEIGHT}px` }}
        >
          {duration && ticks.map((t) => {
            const pct = (t / duration) * 100;
            return (
              <div
                key={t}
                className="pointer-events-none absolute top-0 -translate-x-1/2 text-[9px] tabular-nums text-muted-foreground/70"
                style={{ left: `${pct}%` }}
              >
                <div className="mx-auto h-1 w-px bg-border" />
                <span className="block">{formatTs(t).replace(/^00:/, "")}</span>
              </div>
            );
          })}
        </div>
      </div>

    </>
  );
}

// ── VideoCardDragOverlay ──────────────────────────────────────────────
//
// 一层透明覆盖, 精确铺在视频卡上 (跟随 zoom/pan/卡片移动). 拖帧模式下出现,
// 用户从覆盖层上按住拖出去 = 抽当前视频帧到落点。视频卡本身已经在显示
// playhead 那一帧 (TimelineScrubber 的 seekVideo 实时驱动), 所以不再需要
// 单独再做一个"当前帧浮窗" — 视频卡就是当前帧。
//
// 角落有个小提示 "⇲ 拖出抽帧 02:13.5", 暗示这块可拖。
// 拖动时光标边浮一个纯文字标签 (不复制视频帧 — 避免 canvas capture 黑帧的坑)。

interface DragOverlayProps {
  cardId: string;
  target: ExtractTarget;
}

function VideoCardDragOverlay({ cardId, target }: DragOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const ghostLabelRef = useRef<HTMLDivElement>(null);
  const tsBadgeRef = useRef<HTMLSpanElement>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const [dragging, setDragging] = useState(false);

  // 找到 live <video>, 订阅 seeked 持续更新角标时间戳
  useEffect(() => {
    const el = document.querySelector(
      `[data-card-id="${cardId}"] video`,
    ) as HTMLVideoElement | null;
    if (!el) return;
    videoElRef.current = el;

    const updateBadge = () => {
      const lbl = tsBadgeRef.current;
      if (lbl) lbl.textContent = formatTs(el.currentTime || 0);
    };
    updateBadge();
    el.addEventListener("seeked", updateBadge);
    return () => {
      el.removeEventListener("seeked", updateBadge);
      videoElRef.current = null;
    };
  }, [cardId]);

  // 位置同步: 精确铺在视频卡上 (left/top/width/height 都跟着 zoom + 拖动)
  useLayoutEffect(() => {
    let rafId = 0;
    let scheduled = false;
    const sync = () => {
      scheduled = false;
      const c = useCardStore.getState().cards.get(cardId);
      if (!c) return;
      const vp = liveViewport;
      const off = useCanvasStore.getState().dragOffsets.get(cardId);
      const offDx = off ? off.dx * vp.zoom : 0;
      const offDy = off ? off.dy * vp.zoom : 0;
      const el = overlayRef.current;
      if (el) {
        el.style.left = `${c.x * vp.zoom + vp.x + offDx}px`;
        el.style.top = `${c.y * vp.zoom + vp.y + offDy}px`;
        el.style.width = `${c.width * vp.zoom}px`;
        el.style.height = `${c.height * vp.zoom}px`;
      }
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
  }, [cardId]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      setDragging(true);

      const onMove = (ev: PointerEvent) => {
        const g = ghostRef.current;
        if (g) {
          g.style.left = `${ev.clientX + 14}px`;
          g.style.top = `${ev.clientY + 14}px`;
        }
        const lbl = ghostLabelRef.current;
        if (lbl && videoElRef.current) {
          lbl.textContent = `抽帧 @ ${formatTs(videoElRef.current.currentTime || 0)}`;
        }
      };

      const onUp = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setDragging(false);

        // 拦下随即的 click, 避免 overlay onClick 被误触
        const blockClick = (ce: Event) => {
          ce.stopPropagation();
          ce.stopImmediatePropagation();
          ce.preventDefault();
        };
        window.addEventListener("click", blockClick, { capture: true, once: true });
        setTimeout(
          () => window.removeEventListener("click", blockClick, { capture: true }),
          200,
        );

        // 释放在 overlay 自己上 = 反悔, 不抽帧; 释放在外面 = 抽到落点
        const overlayEl = overlayRef.current;
        if (!overlayEl) return;
        const r = overlayEl.getBoundingClientRect();
        const insideOverlay =
          ev.clientX >= r.left &&
          ev.clientX <= r.right &&
          ev.clientY >= r.top &&
          ev.clientY <= r.bottom;
        if (!insideOverlay) {
          // video.currentTime 是 ground truth, 不读 React state
          const ts = videoElRef.current?.currentTime ?? 0;
          const dropPos = screenToCanvas(ev.clientX, ev.clientY);
          void extractFrameAtTimestamp(target, ts, dropPos);
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [target],
  );

  return (
    <>
      <div
        ref={overlayRef}
        className="absolute z-30 cursor-grab select-none active:cursor-grabbing"
        onPointerDown={handlePointerDown}
        title="按住从视频卡拖到画布空白处, 抽出当前帧到落点"
      >
        {/* 拖帧提示角标 — 让用户知道这里可拖 */}
        <div className="pointer-events-none absolute right-2 bottom-2 flex items-center gap-1.5 rounded-md bg-black/75 px-2 py-1 text-[11px] font-medium text-white shadow-lg backdrop-blur-sm">
          <span>⇲ 拖出抽帧</span>
          <span ref={tsBadgeRef} className="rounded bg-white/20 px-1 tabular-nums">
            00:00.0
          </span>
        </div>
      </div>

      {dragging && (
        <div
          ref={ghostRef}
          className="pointer-events-none fixed z-[9999] rounded-md bg-primary px-3 py-2 text-[12px] font-medium text-primary-foreground shadow-2xl"
        >
          <div ref={ghostLabelRef}>抽帧 @ 00:00.0</div>
          <div className="mt-0.5 text-[10px] opacity-75">松手到画布空白处</div>
        </div>
      )}
    </>
  );
}

function formatTs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

// ── 主组件 ────────────────────────────────────────────────────────────

export default function VideoToolbar() {
  const editingCardId = useCanvasStore((s) => s.editingCardId);
  const selectedCardIds = useCanvasStore((s) => s.selectedCardIds);

  const targetCardId =
    editingCardId ??
    (selectedCardIds.size === 1 ? Array.from(selectedCardIds)[0] : undefined);

  const card = useCardStore((s) =>
    targetCardId ? s.cards.get(targetCardId) : undefined,
  );

  const toolbarRef = useRef<HTMLDivElement>(null);
  const [extractOpen, setExtractOpen] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // 拖帧焦点模式由 canvasStore 集中管理:
  //   - FloatingEditor 通过同一 state 自动收起,腾出卡下方空间;
  //   - 切换目标卡 / 卡片被删除时, useEffect 自动 nuke 状态;
  //   - Esc 键 / 点别处 / 再按一次按钮都能退出。
  const scrubberActiveCardId = useCanvasStore((s) => s.scrubberActiveCardId);
  const setScrubberActiveCardId = useCanvasStore((s) => s.setScrubberActiveCardId);
  const scrubberOpen = !!targetCardId && scrubberActiveCardId === targetCardId;
  const toggleScrubber = useCallback(() => {
    setScrubberActiveCardId(scrubberOpen ? null : (targetCardId ?? null));
  }, [scrubberOpen, targetCardId, setScrubberActiveCardId]);
  const closeScrubber = useCallback(() => {
    setScrubberActiveCardId(null);
  }, [setScrubberActiveCardId]);

  // toolbar 跟随 — 与 ImageToolbar 同样的 imperative pattern
  useLayoutEffect(() => {
    if (!targetCardId) return;
    let rafId = 0;
    let scheduled = false;
    let prevSig = "";

    const sync = () => {
      scheduled = false;
      const c = useCardStore.getState().cards.get(targetCardId);
      if (!c) return;
      const vp = liveViewport;
      const off = useCanvasStore.getState().dragOffsets.get(targetCardId);
      const offDx = off ? off.dx * vp.zoom : 0;
      const offDy = off ? off.dy * vp.zoom : 0;
      const left = c.x * vp.zoom + vp.x + offDx;
      const top = c.y * vp.zoom + vp.y + offDy;
      const width = c.width * vp.zoom;
      const sig = `${left}|${top}|${width}`;
      if (sig === prevSig) return;
      prevSig = sig;
      const tb = toolbarRef.current;
      if (tb) {
        tb.style.left = `${left + width / 2}px`;
        tb.style.top = `${top - TOOLBAR_GAP}px`;
      }
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
  }, [targetCardId]);

  // 切换目标卡时清掉缓存时长 + 自动退出别卡的拖帧 (避免 scrubberActiveCardId 残留指向已离场的卡)
  useEffect(() => {
    setDuration(null);
    if (scrubberActiveCardId && scrubberActiveCardId !== targetCardId) {
      setScrubberActiveCardId(null);
    }
    // 故意不依赖 scrubberActiveCardId — 否则会在我们自己关闭它时再触发一遍 effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetCardId]);

  const target: ExtractTarget | null = useMemo(() => {
    if (!card || card.type !== "ai_video") return null;
    const d = card.data as VideoData;
    if (!d.videoUrl) return null;
    return { videoUrl: d.videoUrl, videoCardId: card.id };
  }, [card]);

  // scrubber 打开时拉一次时长 (优先 ffmpeg, 失败兜底 HTML video)
  useEffect(() => {
    if (!scrubberOpen || !target) return;
    let cancelled = false;
    (async () => {
      const fromRust = await probeDuration(target.videoUrl);
      if (cancelled) return;
      if (fromRust != null) {
        setDuration(fromRust);
        return;
      }
      // HTML 兜底
      const v = document.createElement("video");
      v.preload = "metadata";
      v.src = getDisplayUrl(target.videoUrl);
      v.onloadedmetadata = () => {
        if (!cancelled) setDuration(Number.isFinite(v.duration) ? v.duration : null);
      };
      v.onerror = () => { if (!cancelled) setDuration(null); };
    })();
    return () => { cancelled = true; };
  }, [scrubberOpen, target]);

  const handleExtract = useCallback(
    (mode: ExtractMode) => {
      if (!target) return;
      void extractFramesFromVideo(target, mode);
    },
    [target],
  );

  const handleContinue = useCallback(() => {
    if (!target) return;
    void continueShotFromVideo(target);
  }, [target]);

  const handleDownload = useCallback(async () => {
    if (!card) return;
    const d = card.data as VideoData;
    if (!d.videoUrl) return;
    if (d.videoUrl.startsWith("data:") || d.videoUrl.startsWith("http")) {
      useUIStore.getState().addToast({
        type: "info",
        title: "该视频暂不支持直接下载",
        duration: 2500,
      });
      return;
    }
    try {
      await exportFile(d.videoUrl, d.content || "AI视频", card.projectId);
      useUIStore.getState().addToast({ type: "success", title: "视频已导出", duration: 3000 });
    } catch (err) {
      useUIStore.getState().addToast({
        type: "error",
        title: "导出失败",
        description: String(err),
        duration: 5000,
      });
    }
  }, [card]);

  const isRemoteUrl = useCallback((url?: string) => {
    return !!url && (url.startsWith("http://") || url.startsWith("https://"));
  }, []);

  const handleSaveLocal = useCallback(async () => {
    if (!card || saving) return;
    const d = card.data as VideoData;
    if (!d.videoUrl || !isRemoteUrl(d.videoUrl)) return;

    setSaving(true);
    try {
      const { localPath } = await persistImage(d.videoUrl, card.title || undefined, card.projectId);
      useCardStore.getState().updateCard(card.id, {
        data: { ...card.data, videoUrl: localPath },
      });
      autoSave.markDirty(card.id);
      useUIStore.getState().addToast({
        type: "success",
        title: "视频已保存到本地",
        duration: 2500,
      });
    } catch (err) {
      useUIStore.getState().addToast({
        type: "error",
        title: "保存失败",
        description: String(err),
        duration: 5000,
      });
    } finally {
      setSaving(false);
    }
  }, [card, saving, isRemoteUrl]);

  if (!card || card.type !== "ai_video") return null;
  const d = card.data as VideoData;
  if (!d.videoUrl) return null;

  const showSaveLocal = isRemoteUrl(d.videoUrl);
  const continueCheck = canContinueShot(d.model);
  const continueDisabled = !continueCheck.ok || isVeoReferenceMode(d.model, d.imageMode);
  const continueTitle = isVeoReferenceMode(d.model, d.imageMode)
    ? "Veo 参考模式不支持续拍,请切到首尾帧模式"
    : continueCheck.reason ?? "用尾帧作为下段视频的首帧,串接长镜头";

  return (
    <>
      <div
        ref={toolbarRef}
        className="absolute z-50"
        style={{ transform: "translateX(-50%) translateY(-100%)" }}
      >
        <div
          className="video-toolbar flex items-center gap-1 rounded-lg border border-border/60 bg-card/95 px-2 py-1 shadow-xl backdrop-blur-md"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 抽帧组 */}
          <div className="relative">
            <button
              title="按策略批量抽帧 → 派生图卡"
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              onClick={() => setExtractOpen((v) => !v)}
            >
              <Film className="h-3.5 w-3.5" />
              <span>抽帧</span>
              <ChevronDown className="h-3 w-3" />
            </button>
            <ExtractMenu
              open={extractOpen}
              onClose={() => setExtractOpen(false)}
              onChoose={handleExtract}
            />
          </div>

          {VIDEO_FEATURES.dragFrame && (
            <button
              title="拖帧模式: 用时间轴 playhead 挑帧, 从当前帧浮窗拖到画布抽帧 (再按一次或 Esc 退出)"
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                scrubberOpen
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              onClick={toggleScrubber}
            >
              <Crosshair className="h-3.5 w-3.5" />
              <span>拖帧</span>
            </button>
          )}

          {/* 创作组 */}
          {VIDEO_FEATURES.continueShot && (
            <>
              <div className="mx-0.5 h-4 w-px bg-border" />
              <button
                title={continueTitle}
                disabled={continueDisabled}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                  "text-muted-foreground hover:bg-muted hover:text-foreground",
                  continueDisabled && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground",
                )}
                onClick={handleContinue}
              >
                <Link2 className="h-3.5 w-3.5" />
                <span>续拍</span>
              </button>
            </>
          )}

          <div className="mx-0.5 h-4 w-px bg-border" />

          {/* I/O 组 */}
          {showSaveLocal && (
            <>
              <button
                title="保存到本地"
                disabled={saving}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                  "bg-amber-500/15 text-amber-600 hover:bg-amber-500/25 dark:text-amber-400",
                  saving && "cursor-not-allowed opacity-60",
                )}
                onClick={() => void handleSaveLocal()}
              >
                {saving
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <HardDriveDownload className="h-3.5 w-3.5" />
                }
                <span>{saving ? "保存中…" : "保存到本地"}</span>
              </button>
              <div className="mx-0.5 h-4 w-px bg-border" />
            </>
          )}

          <button
            title="下载视频"
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => void handleDownload()}
          >
            <Download className="h-3.5 w-3.5" />
            <span>下载</span>
          </button>
        </div>
      </div>

      {scrubberOpen && targetCardId && target && (
        <>
          <TimelineScrubber
            cardId={targetCardId}
            target={target}
            duration={duration}
            onClose={closeScrubber}
          />
          <VideoCardDragOverlay cardId={targetCardId} target={target} />
        </>
      )}
    </>
  );
}
