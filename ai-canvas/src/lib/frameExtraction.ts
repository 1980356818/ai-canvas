//! 视频关键帧提取的全部业务逻辑。
//!
//! 设计原则:
//!   1. **单一入口** — UI 组件只调 `runFrameExtraction(cardId)`,内部串完全流程
//!      (解析分镜 JSON → 定位视频源 → 调 ffmpeg → 探测比例 → 派生卡 → 更新自身状态)。
//!   2. **类型 / 常量统一** — 所有跟 frame_extractor 卡相关的字段、产出物、布局
//!      参数都在本模块导出,UI 端不再硬编码。
//!   3. **依赖隐式注入** — 内部直接 `useCardStore.getState()` / `useUIStore.getState()`,
//!      调用方不传 deps,避免组件层耦合一堆 imports。
//!   4. **错误集中** — 所有失败路径都 throw + 由入口函数 try/catch,
//!      落到卡片 `status: "error"` + 一条 toast。

import { useCardStore } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { saveCardsBatch } from "@/platform";
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
  derivedCardId: string;
}

export type FrameExtractorStatus = "idle" | "running" | "done" | "error";

export interface FrameExtractorData {
  upstreamChatResult?: string;
  upstreamChatCardId?: string;
  sourceVideoUrl?: string;
  sourceVideoCardId?: string;
  extractedFrames?: ExtractedFrame[];
  status?: FrameExtractorStatus;
  errorMessage?: string;
}

// ── 常量 ──────────────────────────────────────────────────────────────

/** 派生 ai_image 卡片的最长边像素。16:9 → 240×135,9:16 → 135×240。 */
export const FRAME_CARD_MAX_EDGE = 240;

/** 派生卡片网格布局参数。 */
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

function buildDerivedImageCards(args: {
  anchor: { x: number; y: number };
  size: { width: number; height: number };
  shots: Shot[];
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
    const title =
      `分镜 ${shot.index} · ${formatTimestamp(shot.start)}` +
      (shot.shot_type ? ` · ${shot.shot_type}` : "");
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
        content: shot.description ?? "",
      },
      createdAt: now,
      updatedAt: now,
    };
  });
}

// ── 入口 ──────────────────────────────────────────────────────────────

/**
 * 单一入口:跑完整的"分镜 JSON → 抽帧 → 派生图片卡"流程。
 *
 * 不抛错(所有失败都吃掉并 toast + 把卡置为 error 状态),
 * 调用方不用 try/catch。
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

  // ── 前置校验 ──
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

    // ── 2. 探测比例 + 算尺寸 ──
    const ratio = await probeAspectRatio(getDisplayUrl(framePaths[0]!));
    const size = frameCardSize(ratio);

    // ── 3. 构造派生卡片 ──
    const derived = buildDerivedImageCards({
      anchor: {
        x: card.x,
        y: card.y + card.height + FRAME_GRID.topOffset,
      },
      size,
      shots: parsed.shots,
      framePaths,
      projectId: card.projectId,
    });

    // ── 4. 落库 + 写入 store ──
    await saveCardsBatch(derived.map(cardToRow));
    for (const c of derived) cardStore.addCard(c);

    // ── 5. 更新自身 + 通知 ──
    const extractedFrames: ExtractedFrame[] = parsed.shots.map((shot, i) => ({
      index: shot.index,
      timestamp: shot.keyframe_timestamp,
      framePath: framePaths[i]!,
      derivedCardId: derived[i]!.id,
    }));

    cardStore.updateCardData(extractorCardId, {
      status: "done",
      extractedFrames,
      errorMessage: undefined,
    } satisfies Partial<FrameExtractorData>);
    autoSave.markDirty(extractorCardId);

    uiStore.addToast({
      type: "info",
      title: `已提取 ${derived.length} 个关键帧`,
      duration: 2500,
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
