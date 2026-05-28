//! 视频卡片工具栏的全部业务逻辑。
//!
//! 设计原则与 `frameExtraction.ts` 一致:
//!   1. **单一入口**: UI 组件只调本模块导出的高层函数,不自己拼派生卡片;
//!   2. **错误集中**: 失败统一 toast + 早返回, UI 无需 try/catch;
//!   3. **依赖隐式**: 直接 `useCardStore.getState()` / `useUIStore.getState()`,
//!      调用方不传 deps;
//!   4. **复用 frameExtraction**: 派生 ai_image 卡的构造直接借 `buildDerivedImageCards`
//!      所沿用的 grid 排版,行为/外观对齐 frame_extractor 节点出图。

import { useCardStore } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { useProjectStore } from "@/stores/projectStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { autoSave } from "@/lib/autoSave";
import { getDisplayUrl } from "@/lib/media";
import { saveCardsBatch } from "@/platform";
import { updateProjectMeta } from "@/platform";
import { cardToRow } from "@/lib/mappers";
import { sizeFromRatio } from "@/shared/constants";
import {
  FRAME_GRID,
  formatTimestamp,
  frameCardSize,
} from "@/lib/frameExtraction";
import { isVeoModel } from "@/providers/shared/video";
import type { CanvasCard, Connection } from "@/types";

// ── 类型 ──────────────────────────────────────────────────────────────

export interface ExtractTarget {
  /** 视频源 URL,可以是 `local://...` / 相对存储路径 / 绝对路径 (前端透传给 Rust)。 */
  videoUrl: string;
  /** 锚点卡片 ID — 派生图卡相对它定位 + 默认作为 project 归属。 */
  videoCardId: string;
}

export interface ExtractedShot {
  index: number;
  timestamp: number;
  title?: string;
}

// ── Rust 调用封装 ─────────────────────────────────────────────────────

async function callRust<T>(
  command: "extract_frames_at_timestamps" | "probe_video_duration" | "detect_scene_changes",
  args: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

// ── 通用:派生 ai_image 卡 ────────────────────────────────────────────
//
// 与 frameExtraction.buildDerivedImageCards 同样的 5 列网格,但允许
// 调用方传 `titles` 自定义每张图的标题。

function buildDerivedImageCards(args: {
  anchor: { x: number; y: number };
  size: { width: number; height: number };
  shots: ExtractedShot[];
  framePaths: string[];
  projectId: string;
}): CanvasCard[] {
  const { anchor, size, shots, framePaths, projectId } = args;
  const { width: W, height: H } = size;
  const { cols, gapX, gapY } = FRAME_GRID;
  const now = new Date().toISOString();

  let zCursor = useCardStore.getState().maxZIndex;
  return shots.map((shot, i): CanvasCard => {
    zCursor += 1;
    const title = shot.title ?? `帧 ${shot.index} · ${formatTimestamp(shot.timestamp)}`;
    return {
      id: crypto.randomUUID(),
      projectId,
      type: "ai_image",
      x: anchor.x + (i % cols) * (W + gapX),
      y: anchor.y + Math.floor(i / cols) * (H + gapY),
      width: W,
      height: H,
      zIndex: zCursor,
      locked: false,
      collapsed: false,
      title,
      data: {
        imageUrl: framePaths[i],
        content: "",
      },
      createdAt: now,
      updatedAt: now,
    };
  });
}

/** 读派生卡片的目标比例。失败 fallback 16:9, 不阻塞主流程。 */
function probeAspectRatio(displayUrl: string): Promise<number> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const r = img.naturalWidth / img.naturalHeight;
      resolve(r > 0 && Number.isFinite(r) ? r : 16 / 9);
    };
    img.onerror = () => resolve(16 / 9);
    img.src = displayUrl;
  });
}

async function commitDerivedCards(
  videoCard: CanvasCard,
  shots: ExtractedShot[],
  framePaths: string[],
): Promise<CanvasCard[]> {
  if (shots.length === 0 || framePaths.length === 0) return [];

  const ratio = await probeAspectRatio(getDisplayUrl(framePaths[0]!));
  const size = frameCardSize(ratio);

  const derived = buildDerivedImageCards({
    anchor: {
      x: videoCard.x,
      y: videoCard.y + videoCard.height + FRAME_GRID.topOffset,
    },
    size,
    shots,
    framePaths,
    projectId: videoCard.projectId,
  });

  await saveCardsBatch(derived.map(cardToRow));
  const cardStore = useCardStore.getState();
  for (const c of derived) cardStore.addCard(c);

  const count = cardStore.getCardsByProject(videoCard.projectId).length;
  useProjectStore.getState().updateProject(videoCard.projectId, { nodeCount: count });
  void updateProjectMeta(videoCard.projectId, { nodeCount: count });

  return derived;
}

// ── 时间戳生成策略 ────────────────────────────────────────────────────

/** N 等分:[t/N, 2t/N, ..., (N-1)t/N] — 不取 0 和末尾 (黑帧/淡出兜底)。 */
function equalSplits(durationSec: number, n: number): number[] {
  if (n <= 0 || durationSec <= 0) return [];
  const ts: number[] = [];
  for (let i = 1; i <= n; i++) {
    ts.push((durationSec * i) / (n + 1));
  }
  return ts;
}

/** 等间隔:0, step, 2*step, ... 直到 duration-step (排除末尾,避免末帧黑屏)。 */
function evenInterval(durationSec: number, stepSec: number): number[] {
  if (stepSec <= 0 || durationSec <= 0) return [];
  const ts: number[] = [];
  // 从 step/2 起步 (避免开头淡入黑帧),但用户预期"每 N 秒一帧"应从 0 算,所以折中:
  // 第一张用 stepSec*0.1 (≈ 起手帧), 之后按 step 走。
  ts.push(Math.min(stepSec * 0.1, 0.5));
  let t = stepSec;
  while (t < durationSec - 0.05) {
    ts.push(t);
    t += stepSec;
  }
  return ts;
}

/** 首尾帧:[0.1, duration-0.1] —— 末尾留 0.1s 避开黑帧。 */
function firstAndLast(durationSec: number): number[] {
  if (durationSec <= 0.5) return [Math.max(0, durationSec / 2)];
  return [0.1, Math.max(0.1, durationSec - 0.1)];
}

// ── 公开:抽帧入口 (4 种策略) ─────────────────────────────────────────

export type ExtractMode =
  | { kind: "scene"; threshold?: number }
  | { kind: "interval"; stepSec: number }
  | { kind: "equal"; count: number }
  | { kind: "firstLast" };

function modeLabel(mode: ExtractMode): string {
  switch (mode.kind) {
    case "scene": return "智能关键帧";
    case "interval": return `每 ${mode.stepSec}s 抽帧`;
    case "equal": return `${mode.count} 等分`;
    case "firstLast": return "首尾帧";
  }
}

/** 主入口:按 mode 解析时间戳 → ffmpeg 抽帧 → 派生图卡。 */
export async function extractFramesFromVideo(
  target: ExtractTarget,
  mode: ExtractMode,
): Promise<void> {
  const cardStore = useCardStore.getState();
  const uiStore = useUIStore.getState();
  const videoCard = cardStore.getCard(target.videoCardId);
  if (!videoCard) return;

  const label = modeLabel(mode);
  uiStore.setCardProgress(target.videoCardId, { percent: 0, label: `准备 ${label}…` });

  try {
    // 1. 准备时间戳
    let timestamps: number[];
    let shotTitles: (string | undefined)[] = [];

    if (mode.kind === "scene") {
      const stamps = await callRust<number[]>("detect_scene_changes", {
        videoPath: target.videoUrl,
        threshold: mode.threshold ?? 0.4,
      });
      // 去重 + 去掉过密 (相邻 < 0.3s 视为同一切点抖动)
      const dedup: number[] = [];
      for (const t of stamps) {
        if (dedup.length === 0 || t - dedup[dedup.length - 1]! > 0.3) {
          dedup.push(t);
        }
      }
      timestamps = dedup;
      if (timestamps.length === 0) {
        uiStore.addToast({
          type: "warning",
          title: "未检测到镜头切换",
          description: "可能是单镜头视频,试试 N 等分或等间隔抽帧",
          duration: 4000,
        });
        return;
      }
      shotTitles = timestamps.map((_, i) => `镜头 ${i + 1}`);
    } else if (mode.kind === "firstLast") {
      const dur = await callRust<number>("probe_video_duration", {
        videoPath: target.videoUrl,
      });
      timestamps = firstAndLast(dur);
      shotTitles = timestamps.length === 2 ? ["首帧", "尾帧"] : ["单帧"];
    } else {
      const dur = await callRust<number>("probe_video_duration", {
        videoPath: target.videoUrl,
      });
      timestamps = mode.kind === "interval"
        ? evenInterval(dur, mode.stepSec)
        : equalSplits(dur, mode.count);
    }

    if (timestamps.length === 0) {
      uiStore.addToast({
        type: "warning",
        title: `${label} 计算到 0 帧`,
        duration: 3000,
      });
      return;
    }

    // 安全护栏: Rust 端硬上限 100, 这里提前截断 + 警告。
    if (timestamps.length > 50) {
      uiStore.addToast({
        type: "warning",
        title: `${label} 计算到 ${timestamps.length} 帧,已截断到前 50`,
        description: "如需更多请调整策略",
        duration: 4000,
      });
      timestamps = timestamps.slice(0, 50);
      shotTitles = shotTitles.slice(0, 50);
    }

    uiStore.setCardProgress(target.videoCardId, {
      percent: 0,
      label: `正在抽 ${timestamps.length} 帧…`,
    });

    // 2. 调 Rust 抽帧
    const framePaths = await callRust<string[]>("extract_frames_at_timestamps", {
      videoPath: target.videoUrl,
      timestamps,
    });

    if (framePaths.length !== timestamps.length) {
      throw new Error(`抽帧数量不匹配: 期望 ${timestamps.length},实际 ${framePaths.length}`);
    }

    // 3. 构造派生卡 + 落库
    const shots: ExtractedShot[] = timestamps.map((t, i) => ({
      index: i + 1,
      timestamp: t,
      title: shotTitles[i],
    }));
    const derived = await commitDerivedCards(videoCard, shots, framePaths);

    uiStore.addToast({
      type: "info",
      title: `${label} · 已生成 ${derived.length} 张图卡`,
      duration: 2500,
    });
  } catch (err) {
    uiStore.addToast({
      type: "error",
      title: `${label} 失败`,
      description: err instanceof Error ? err.message : String(err),
      duration: 5000,
    });
  } finally {
    uiStore.setCardProgress(target.videoCardId, null);
  }
}

// ── 公开:拖帧出图 (timeline scrubber drop) ──────────────────────────
//
// 与 ImageToolbar 的宫格拖拽对齐:UI 用 pointermove 把浮动框跟手,
// 释放时 UI 调本函数,传入屏幕坐标 + 时间戳 + 视频源。

export async function extractFrameAtTimestamp(
  target: ExtractTarget,
  timestampSec: number,
  dropCanvasPos: { x: number; y: number },
): Promise<void> {
  const cardStore = useCardStore.getState();
  const uiStore = useUIStore.getState();
  const videoCard = cardStore.getCard(target.videoCardId);
  if (!videoCard) return;

  uiStore.setCardProgress(target.videoCardId, {
    percent: 0,
    label: `抽帧 ${formatTimestamp(timestampSec)}…`,
  });

  try {
    const framePaths = await callRust<string[]>("extract_frames_at_timestamps", {
      videoPath: target.videoUrl,
      timestamps: [timestampSec],
    });
    if (framePaths.length === 0) throw new Error("ffmpeg 未返回帧路径");
    const framePath = framePaths[0]!;

    const ratio = await probeAspectRatio(getDisplayUrl(framePath));
    // 单帧用 CARD_MAX_EDGE 完整尺寸 (与 ai_image 默认一致), 不缩到 240px 的网格预览尺寸。
    // 这样用户拖一帧出来就是张主图卡, 可以直接接下游模型。
    const { width: W, height: H } = sizeFromRatio(ratio);

    const { maxZIndex } = cardStore;
    const now = new Date().toISOString();
    const newCard: CanvasCard = {
      id: crypto.randomUUID(),
      projectId: videoCard.projectId,
      type: "ai_image",
      x: dropCanvasPos.x - W / 2,
      y: dropCanvasPos.y - H / 2,
      width: W,
      height: H,
      zIndex: maxZIndex + 1,
      locked: false,
      collapsed: false,
      title: `${formatTimestamp(timestampSec)} 帧`,
      data: { imageUrl: framePath, content: "" },
      createdAt: now,
      updatedAt: now,
    };

    cardStore.addCard(newCard);
    autoSave.markDirty(newCard.id);
    useCanvasStore.getState().setSelectedCardIds([newCard.id]);

    const count = cardStore.getCardsByProject(videoCard.projectId).length;
    useProjectStore.getState().updateProject(videoCard.projectId, { nodeCount: count });
    void updateProjectMeta(videoCard.projectId, { nodeCount: count });
  } catch (err) {
    uiStore.addToast({
      type: "error",
      title: "抽帧失败",
      description: err instanceof Error ? err.message : String(err),
      duration: 5000,
    });
  } finally {
    uiStore.setCardProgress(target.videoCardId, null);
  }
}

// ── 公开:续拍 (尾帧 → 新视频卡的首帧) ──────────────────────────────

/**
 * 抽视频尾帧 → 派生一个新 ai_video 卡 (无 videoUrl) + 在 refFrames 里挂入尾帧 (作为首帧角色)
 * → 自动建立连线。用户接下来双击新卡 + 输入 prompt + 点生成即可。
 *
 * 模型默认从用户的 `lastModel("video")` 复用 (与新建视频卡时一致),
 * 调用方有责任在 UI 上对"不支持 firstFrame 的模型"置灰按钮。
 */
export async function continueShotFromVideo(target: ExtractTarget): Promise<void> {
  const cardStore = useCardStore.getState();
  const uiStore = useUIStore.getState();
  const videoCard = cardStore.getCard(target.videoCardId);
  if (!videoCard) return;

  uiStore.setCardProgress(target.videoCardId, { percent: 0, label: "抽取尾帧…" });

  try {
    // 1. 探时长 → 拿到 last-frame timestamp (-0.1s 避开黑帧)
    const dur = await callRust<number>("probe_video_duration", {
      videoPath: target.videoUrl,
    });
    const tailTs = Math.max(0, dur - 0.1);

    // 2. ffmpeg 抽尾帧
    const framePaths = await callRust<string[]>("extract_frames_at_timestamps", {
      videoPath: target.videoUrl,
      timestamps: [tailTs],
    });
    if (framePaths.length === 0) throw new Error("尾帧抽取失败");
    const tailFramePath = framePaths[0]!;

    // 3. 派生新 ai_video 卡 (镜像原卡比例 + 沿用上次模型)
    const { maxZIndex } = cardStore;
    const last = useSettingsStore.getState().getLastModel("video");
    const now = new Date().toISOString();
    const GAP = 80;

    const newCard: CanvasCard = {
      id: crypto.randomUUID(),
      projectId: videoCard.projectId,
      type: "ai_video",
      x: videoCard.x + videoCard.width + GAP,
      y: videoCard.y,
      width: videoCard.width,
      height: videoCard.height,
      zIndex: maxZIndex + 1,
      locked: false,
      collapsed: false,
      title: "续拍",
      data: {
        content: "",
        imageMode: "firstLastFrame",
        // refFrames 第 1 项 = 首帧 (VideoEditor / dataFlow 都按这个约定)
        refFrames: [{ url: tailFramePath, sourceCardId: videoCard.id }],
        model: last?.modelId,
        provider: last?.providerId,
      },
      createdAt: now,
      updatedAt: now,
    };
    cardStore.addCard(newCard);

    // 4. 建立连线 (原视频 → 新视频)
    const conn: Connection = {
      id: crypto.randomUUID(),
      projectId: videoCard.projectId,
      sourceCardId: videoCard.id,
      targetCardId: newCard.id,
      createdAt: now,
    };
    useConnectionStore.getState().addConnection(conn);

    useCanvasStore.getState().setSelectedCardIds([newCard.id]);
    useCanvasStore.getState().setEditingCardId(newCard.id);

    autoSave.markDirty(newCard.id);
    const count = cardStore.getCardsByProject(videoCard.projectId).length;
    useProjectStore.getState().updateProject(videoCard.projectId, { nodeCount: count });
    void updateProjectMeta(videoCard.projectId, { nodeCount: count });

    uiStore.addToast({
      type: "info",
      title: "已创建续拍卡片",
      description: "输入新镜头描述后点生成,首帧已自动绑为上段尾帧",
      duration: 3500,
    });
  } catch (err) {
    uiStore.addToast({
      type: "error",
      title: "续拍失败",
      description: err instanceof Error ? err.message : String(err),
      duration: 5000,
    });
  } finally {
    uiStore.setCardProgress(target.videoCardId, null);
  }
}

/** 续拍能力检查:只要模型支持 firstFrame 角色就行 (Seedance/Veo/Grok/Vip 均支持)。 */
export function canContinueShot(modelId: string | undefined): { ok: boolean; reason?: string } {
  if (!modelId) {
    return { ok: false, reason: "请先在视频卡选好模型" };
  }
  // 当前所有 4 个视频家族 (Seedance / Veo / Grok / SeedanceVip) 都支持首帧.
  // 文本-only 的"未来视频模型"暂没有, 留这层方便后续扩展.
  return { ok: true };
}

// ── 公开:生成变体 (克隆 N-1 张) ─────────────────────────────────────

/**
 * 克隆当前视频卡 N-1 次 (N 总数, 默认 3 → 多生成 2 张), 水平排列在右侧。
 *
 * 设计权衡:不自动触发生成 — 视频生成贵且模型/参数可能需要微调,
 * 自动并发 N 次 = 烧 N 倍钱;改成留 2 张空卡 + toast 提示用户双击各张生成,
 * 既能"原地比对", 也避免无意义重复消费。卡片上保留所有连线快照 (refFrames /
 * refImages / refAudios / refVideos 的 url + sourceCardId), 但不重建 Connection
 * 对象, 用户在编辑器里改一张不会影响另一张。
 */
export async function spawnVariants(target: ExtractTarget, total: number = 3): Promise<void> {
  const cardStore = useCardStore.getState();
  const uiStore = useUIStore.getState();
  const videoCard = cardStore.getCard(target.videoCardId);
  if (!videoCard) return;

  const copies = Math.max(1, Math.min(8, total - 1));
  const { maxZIndex } = cardStore;
  const GAP = 40;
  const now = new Date().toISOString();
  const newCards: CanvasCard[] = [];

  for (let i = 0; i < copies; i++) {
    const cloneData = JSON.parse(JSON.stringify(videoCard.data)) as Record<string, unknown>;
    // 清掉结果, 保留 prompt / model / refs / size
    delete cloneData.videoUrl;
    delete cloneData.posterUrl;
    cloneData._resultStale = false;

    newCards.push({
      id: crypto.randomUUID(),
      projectId: videoCard.projectId,
      type: "ai_video",
      x: videoCard.x + (videoCard.width + GAP) * (i + 1),
      y: videoCard.y,
      width: videoCard.width,
      height: videoCard.height,
      zIndex: maxZIndex + 1 + i,
      locked: false,
      collapsed: false,
      title: `变体 ${i + 2}`,
      data: cloneData,
      createdAt: now,
      updatedAt: now,
    });
  }

  try {
    await saveCardsBatch(newCards.map(cardToRow));
    for (const c of newCards) cardStore.addCard(c);
    for (const c of newCards) autoSave.markDirty(c.id);

    useCanvasStore.getState().setSelectedCardIds(newCards.map((c) => c.id));

    const count = cardStore.getCardsByProject(videoCard.projectId).length;
    useProjectStore.getState().updateProject(videoCard.projectId, { nodeCount: count });
    void updateProjectMeta(videoCard.projectId, { nodeCount: count });

    uiStore.addToast({
      type: "info",
      title: `已克隆 ${copies} 张变体卡`,
      description: "双击进入分别生成,可单独调整 prompt / 参数",
      duration: 3500,
    });
  } catch (err) {
    uiStore.addToast({
      type: "error",
      title: "克隆变体失败",
      description: err instanceof Error ? err.message : String(err),
      duration: 5000,
    });
  }
}

// ── 公开:抽到视频时长 (UI 用) ───────────────────────────────────────

/**
 * 仅用于 UI: 渲染时间轴 scrubber 时需要知道 totalSec。
 * 失败返回 null, UI 应退化到 video.duration (HTML video) 兜底。
 */
export async function probeDuration(videoUrl: string): Promise<number | null> {
  try {
    return await callRust<number>("probe_video_duration", { videoPath: videoUrl });
  } catch {
    return null;
  }
}

// ── 工具:Veo 兜底 (避免 UI 误把 Veo ref 模式当作可续拍) ──────────────

/** Veo 参考模式 (image-asset) 不接受 firstFrame; 续拍按钮在此模式应置灰。 */
export function isVeoReferenceMode(modelId: string | undefined, imageMode: string | undefined): boolean {
  return isVeoModel(modelId) && imageMode === "reference";
}
