//! 视频关键帧提取的全部业务逻辑(条带卡 + 拖出/一键拆分两阶段模型)。
//!
//! 设计原则:
//!   1. **两阶段** — 抽帧 (`runFrameExtraction`) 只把帧落到磁盘 + 写入条带卡的
//!      `extractedFrames[]`(derivedCardId 为空);派生子卡走 `spawnFrameAsCard`
//!      (单帧拖出) 或 `spawnAllUnextractedFrames` (一键批量)。
//!   2. **类型 / 常量统一** — 所有跟 frame_extractor 卡相关的字段、产出物、布局
//!      参数都在本模块导出,UI 端不再硬编码。
//!   3. **依赖隐式注入** — 内部直接 `useCardStore.getState()` / `useUIStore.getState()`,
//!      调用方不传 deps,避免组件层耦合一堆 imports。
//!   4. **错误集中** — 所有失败路径都 throw + 由入口函数 try/catch,
//!      落到卡片 `status: "error"` + 一条 toast。

import { useCardStore } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useProjectStore } from "@/stores/projectStore";
import { saveCardsBatch, updateProjectMeta } from "@/platform";
import { cardToRow } from "@/lib/mappers";
import { autoSave } from "@/lib/autoSave";
import { getDisplayUrl } from "@/lib/media";
import type { CanvasCard } from "@/types";

// ── 类型 ──────────────────────────────────────────────────────────────

export interface Shot {
  index: number;
  start: number;
  end: number;
  duration?: number;
  shot_type?: string;
  camera_move?: string;
  description?: string;
  subject?: string;
  keyframe_timestamp: number;
}

export interface ParsedShots {
  shots: Shot[];
  summary?: string;
  total_duration?: number;
}

export interface ExtractedFrame {
  index: number;
  timestamp: number;
  framePath: string;
  /** 若已派生为 ai_image 子卡,指向该子卡 id;未拆 = undefined。 */
  derivedCardId?: string;
}

export type FrameExtractorStatus = "idle" | "running" | "done" | "error";

export interface FrameExtractorData {
  upstreamChatResult?: string;
  upstreamChatCardId?: string;
  sourceVideoUrl?: string;
  sourceVideoCardId?: string;
  extractedFrames?: ExtractedFrame[];
  /** 抽帧时探测一次的派生卡尺寸,batch / 单拖共用,避免每次重 probe。 */
  frameSize?: { width: number; height: number };
  status?: FrameExtractorStatus;
  errorMessage?: string;
}

// ── 常量 ──────────────────────────────────────────────────────────────

/** 派生 ai_image 卡片的最长边像素。16:9 → 240×135,9:16 → 135×240。 */
export const FRAME_CARD_MAX_EDGE = 240;

/** 一键拆分时派生卡片的网格布局参数。 */
export const FRAME_GRID = {
  cols: 5,
  gapX: 16,
  gapY: 32,
  /** 第一行相对提取器卡片的纵向偏移。 */
  topOffset: 40,
} as const;

// ── 纯函数:解析 / 定位 / 排版 ─────────────────────────────────────────

/** 从 chat 输出(混合 Markdown + JSON)里抠出 ```json``` 代码块并解析。 */
export function parseShotsFromText(text: string | undefined): ParsedShots | null {
  if (!text) return null;
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]!) as ParsedShots;
    if (!Array.isArray(parsed.shots) || parsed.shots.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 优先用直连的 sourceVideoUrl,fallback 沿上游 chat 卡的 refVideos[0]。 */
export function resolveVideoUrl(data: FrameExtractorData): string | null {
  if (data.sourceVideoUrl) return data.sourceVideoUrl;
  if (data.upstreamChatCardId) {
    const chat = useCardStore.getState().getCard(data.upstreamChatCardId);
    if (chat) {
      const refVideos = (chat.data as Record<string, unknown>).refVideos as
        | Array<{ url: string }>
        | undefined;
      if (refVideos && refVideos[0]) return refVideos[0].url;
    }
  }
  return null;
}

/** 秒数 → mm:ss。 */
export function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 按 aspect ratio 算派生卡片宽高(最长边 = FRAME_CARD_MAX_EDGE)。 */
export function frameCardSize(ratio: number): { width: number; height: number } {
  if (ratio >= 1) {
    return {
      width: FRAME_CARD_MAX_EDGE,
      height: Math.round(FRAME_CARD_MAX_EDGE / ratio),
    };
  }
  return {
    width: Math.round(FRAME_CARD_MAX_EDGE * ratio),
    height: FRAME_CARD_MAX_EDGE,
  };
}

/** 读图天然宽高得 aspect ratio。失败 fallback 16:9 不阻塞主流程。 */
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

// ── 派生卡片构造 ──────────────────────────────────────────────────────

/** 给单张关键帧构造一个 ai_image 卡(纯函数,不入库)。 */
function buildFrameCard(args: {
  extractorCard: CanvasCard;
  frame: ExtractedFrame;
  shot: Shot | undefined;
  size: { width: number; height: number };
  position: { x: number; y: number };
  zIndex: number;
}): CanvasCard {
  const { extractorCard, frame, shot, size, position, zIndex } = args;
  const extractorData = extractorCard.data as FrameExtractorData;
  const now = new Date().toISOString();
  const title =
    `分镜 ${frame.index} · ${formatTimestamp(frame.timestamp)}` +
    (shot?.shot_type ? ` · ${shot.shot_type}` : "");
  return {
    id: crypto.randomUUID(),
    projectId: extractorCard.projectId,
    type: "ai_image",
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
    zIndex,
    locked: false,
    collapsed: false,
    title,
    data: {
      imageUrl: frame.framePath,
      content: shot?.description ?? "",
      // 血缘元数据:用于回溯到视频对应帧 / 提取器卡
      sourceExtractorCardId: extractorCard.id,
      sourceVideoCardId: extractorData.sourceVideoCardId,
      sourceTimestamp: frame.timestamp,
      sourceFrameIndex: frame.index,
    },
    createdAt: now,
    updatedAt: now,
  };
}

/** addCard / autoSave / nodeCount 一把过。batch=true 时统一走 saveCardsBatch。 */
async function commitDerivedCards(
  newCards: CanvasCard[],
  projectId: string,
  opts: { persistBatch: boolean },
): Promise<void> {
  if (newCards.length === 0) return;
  const cardStore = useCardStore.getState();
  if (opts.persistBatch) {
    await saveCardsBatch(newCards.map(cardToRow));
  }
  for (const c of newCards) {
    cardStore.addCard(c);
    if (!opts.persistBatch) autoSave.markDirty(c.id);
  }
  const count = cardStore.getCardsByProject(projectId).length;
  useProjectStore.getState().updateProject(projectId, { nodeCount: count });
  void updateProjectMeta(projectId, { nodeCount: count });
}

/** 在 extractedFrames[] 里把指定 index 的项打上 derivedCardId(immutable)。 */
function markFramesExtracted(
  frames: ExtractedFrame[],
  updates: Map<number, string>,
): ExtractedFrame[] {
  return frames.map((f) =>
    updates.has(f.index) ? { ...f, derivedCardId: updates.get(f.index)! } : f,
  );
}

// ── 入口 1: 抽帧(只落到条带,不生子卡) ─────────────────────────────

/**
 * 阶段一:解析上游分镜 JSON + 跑 ffmpeg 抽帧,把帧路径写入提取器卡的
 * `extractedFrames[]`(derivedCardId 为空)。**不**派生 ai_image 子卡。
 *
 * 派生子卡走 `spawnFrameAsCard`(单帧拖出)或 `spawnAllUnextractedFrames`
 * (一键批量)。
 */
export async function runFrameExtraction(extractorCardId: string): Promise<void> {
  const cardStore = useCardStore.getState();
  const uiStore = useUIStore.getState();

  const card = cardStore.getCard(extractorCardId);
  if (!card || card.type !== "frame_extractor") {
    uiStore.addToast({
      type: "error",
      title: "提取关键帧失败",
      description: "找不到提取器节点。",
      duration: 4000,
    });
    return;
  }

  const data = card.data as FrameExtractorData;

  const parsed = parseShotsFromText(data.upstreamChatResult);
  if (!parsed) {
    uiStore.addToast({
      type: "error",
      title: "无法提取关键帧",
      description: "上游分镜分析尚未输出有效的 JSON,请先在对话节点点生成。",
      duration: 4000,
    });
    return;
  }

  const videoUrl = resolveVideoUrl(data);
  if (!videoUrl) {
    uiStore.addToast({
      type: "error",
      title: "找不到视频源",
      description: "请把视频卡连到对话节点,或直接连到本节点。",
      duration: 4000,
    });
    return;
  }

  cardStore.updateCardData(extractorCardId, {
    status: "running",
    errorMessage: undefined,
  } satisfies Partial<FrameExtractorData>);

  try {
    // ── 1. 调 ffmpeg 抽帧 ──
    const { invoke } = await import("@tauri-apps/api/core");
    const timestamps = parsed.shots.map((s) => s.keyframe_timestamp);
    const framePaths = await invoke<string[]>("extract_frames_at_timestamps", {
      videoPath: videoUrl,
      timestamps,
    });

    if (framePaths.length !== parsed.shots.length) {
      throw new Error(
        `抽帧数量不匹配:期望 ${parsed.shots.length} 张,实际 ${framePaths.length} 张`,
      );
    }

    // ── 2. 探测比例 + 算尺寸(缓存到卡 data,后续派生子卡共用) ──
    const ratio = await probeAspectRatio(getDisplayUrl(framePaths[0]!));
    const frameSize = frameCardSize(ratio);

    // ── 3. 仅写条带,derivedCardId 留空 ──
    const extractedFrames: ExtractedFrame[] = parsed.shots.map((shot, i) => ({
      index: shot.index,
      timestamp: shot.keyframe_timestamp,
      framePath: framePaths[i]!,
    }));

    cardStore.updateCardData(extractorCardId, {
      status: "done",
      extractedFrames,
      frameSize,
      errorMessage: undefined,
    } satisfies Partial<FrameExtractorData>);
    autoSave.markDirty(extractorCardId);

    uiStore.addToast({
      type: "info",
      title: `已提取 ${extractedFrames.length} 帧`,
      description: "可在条带上拖出单帧,或点「一键拆分」全部生成。",
      duration: 3500,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cardStore.updateCardData(extractorCardId, {
      status: "error",
      errorMessage: msg,
    } satisfies Partial<FrameExtractorData>);
    uiStore.addToast({
      type: "error",
      title: "提取关键帧失败",
      description: msg,
      duration: 5000,
    });
  }
}

// ── 入口 2: 单帧拖出 ──────────────────────────────────────────────────

/**
 * 阶段二(单帧):把指定 index 的关键帧落成一张 ai_image 卡。
 *
 * - `dropPos` 为画布坐标(由 screenToCanvas 转换);新卡中心对齐到该点。
 * - 若该帧已派生且子卡仍存在,直接选中已有子卡(不生重复)。
 *
 * 返回子卡 id;失败返回 null(并 toast)。
 */
export async function spawnFrameAsCard(
  extractorCardId: string,
  frameIndex: number,
  dropPos: { x: number; y: number },
): Promise<string | null> {
  const cardStore = useCardStore.getState();
  const uiStore = useUIStore.getState();

  const card = cardStore.getCard(extractorCardId);
  if (!card || card.type !== "frame_extractor") return null;

  const data = card.data as FrameExtractorData;
  const frames = data.extractedFrames;
  if (!frames || frames.length === 0) return null;

  const frame = frames.find((f) => f.index === frameIndex);
  if (!frame) return null;

  // 已派生且子卡仍在 → 选中已有子卡,不生重复
  if (frame.derivedCardId && cardStore.getCard(frame.derivedCardId)) {
    useCanvasStore.getState().setSelectedCardIds([frame.derivedCardId]);
    return frame.derivedCardId;
  }

  try {
    const size = data.frameSize ?? frameCardSize(16 / 9);
    const parsed = parseShotsFromText(data.upstreamChatResult);
    const shot = parsed?.shots.find((s) => s.index === frame.index);

    const { maxZIndex } = cardStore;
    const newCard = buildFrameCard({
      extractorCard: card,
      frame,
      shot,
      size,
      position: {
        x: dropPos.x - size.width / 2,
        y: dropPos.y - size.height / 2,
      },
      zIndex: maxZIndex + 1,
    });

    await commitDerivedCards([newCard], card.projectId, { persistBatch: false });

    cardStore.updateCardData(extractorCardId, {
      extractedFrames: markFramesExtracted(
        frames,
        new Map([[frame.index, newCard.id]]),
      ),
    } satisfies Partial<FrameExtractorData>);
    autoSave.markDirty(extractorCardId);

    useCanvasStore.getState().setSelectedCardIds([newCard.id]);
    return newCard.id;
  } catch (err) {
    uiStore.addToast({
      type: "error",
      title: "生成子卡失败",
      description: err instanceof Error ? err.message : String(err),
      duration: 4000,
    });
    return null;
  }
}

// ── 入口 3: 一键拆分(批量) ───────────────────────────────────────────

/**
 * 阶段二(批量):把所有还没派生子卡的关键帧一次性铺成 ai_image 卡,
 * 按 `FRAME_GRID` 在提取器卡下方排成网格。
 *
 * - 已派生且子卡仍存在的帧 → 跳过(不重复生)
 * - 已派生但子卡已被删除 → 视为未派生,可重生
 * - 网格按"未派生帧的枚举序"紧凑排列(跳过的不留空位)
 */
export async function spawnAllUnextractedFrames(extractorCardId: string): Promise<void> {
  const cardStore = useCardStore.getState();
  const uiStore = useUIStore.getState();

  const card = cardStore.getCard(extractorCardId);
  if (!card || card.type !== "frame_extractor") return;

  const data = card.data as FrameExtractorData;
  const frames = data.extractedFrames;
  if (!frames || frames.length === 0) return;

  const todo = frames.filter(
    (f) => !f.derivedCardId || !cardStore.getCard(f.derivedCardId),
  );
  if (todo.length === 0) {
    uiStore.addToast({
      type: "info",
      title: "所有关键帧都已拆分",
      duration: 2500,
    });
    return;
  }

  try {
    const size = data.frameSize ?? frameCardSize(16 / 9);
    const parsed = parseShotsFromText(data.upstreamChatResult);
    const { cols, gapX, gapY, topOffset } = FRAME_GRID;
    const anchor = { x: card.x, y: card.y + card.height + topOffset };

    let zCursor = cardStore.maxZIndex;
    const newCards: CanvasCard[] = todo.map((frame, i) => {
      zCursor += 1;
      const shot = parsed?.shots.find((s) => s.index === frame.index);
      return buildFrameCard({
        extractorCard: card,
        frame,
        shot,
        size,
        position: {
          x: anchor.x + (i % cols) * (size.width + gapX),
          y: anchor.y + Math.floor(i / cols) * (size.height + gapY),
        },
        zIndex: zCursor,
      });
    });

    await commitDerivedCards(newCards, card.projectId, { persistBatch: true });

    const updates = new Map<number, string>();
    todo.forEach((f, i) => updates.set(f.index, newCards[i]!.id));

    cardStore.updateCardData(extractorCardId, {
      extractedFrames: markFramesExtracted(frames, updates),
    } satisfies Partial<FrameExtractorData>);
    autoSave.markDirty(extractorCardId);

    uiStore.addToast({
      type: "info",
      title: `已拆分 ${newCards.length} 张关键帧`,
      duration: 2500,
    });
  } catch (err) {
    uiStore.addToast({
      type: "error",
      title: "一键拆分失败",
      description: err instanceof Error ? err.message : String(err),
      duration: 5000,
    });
  }
}
