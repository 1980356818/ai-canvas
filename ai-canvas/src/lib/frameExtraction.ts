//! 视频关键帧提取(智能分镜 flow)。
//!
//! 设计:
//!   1. **单一合成卡产物** — 抽帧后,把 N 张帧合成一张 PNG,作为 `ai_image` 卡片
//!      落到提取器卡下方;提取器卡本身保留作为锚点(chat → extractor → composite)。
//!   2. **派生卡通过"一键拆分"还原** — 合成卡上挂 `compositeFrames`,
//!      ImageToolbar 的拆分按钮调 `lib/frameSplit.ts` 把帧再铺成 N 张独立 ai_image 卡。
//!   3. **错误集中** — 所有失败路径都 throw + 由入口函数 try/catch,
//!      落到 frame_extractor 卡 `status: "error"` + 一条 toast。

import { useCardStore } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useProjectStore } from "@/stores/projectStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { saveCardsBatch, saveConnections, updateProjectMeta } from "@/platform";
import { cardToRow, connectionToRow } from "@/lib/mappers";
import { autoSave } from "@/lib/autoSave";
import { composeFrameGrid, type FrameInput } from "@/lib/frameComposite";
import type { CompositeImageData } from "@/lib/frameSplit";
import type { CanvasCard, Connection } from "@/types";

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

export type FrameExtractorStatus = "idle" | "running" | "done" | "error";

export interface FrameExtractorData {
  upstreamChatResult?: string;
  upstreamChatCardId?: string;
  sourceVideoUrl?: string;
  sourceVideoCardId?: string;
  /** 提取完成后挂的合成 ai_image 卡 id。点"查看合并图"用它跳转。 */
  compositeCardId?: string;
  /** 上次提取的帧数,UI 上"已生成 N 张"用。 */
  lastFrameCount?: number;
  status?: FrameExtractorStatus;
  errorMessage?: string;
}

// ── 常量 ──────────────────────────────────────────────────────────────

/** 派生 ai_image 卡片的最长边像素。16:9 → 240×135,9:16 → 135×240。 */
export const FRAME_CARD_MAX_EDGE = 240;

/**
 * 合成卡最长边 — 按帧数自适应。
 *
 * 合成卡是 N 张帧的 grid,grid 越扁/帧数越多,需要的总宽度就越大才能
 * 保证单格视觉够大;否则会出现"卡片很扁、单格只有几十像素"的小卡问题。
 * 写死 340 (常规图片卡) 在 N=7 时只能撑出 77px 高 → 实际不可用。
 */
export function compositeCardMaxEdge(frameCount: number): number {
  if (frameCount <= 3) return 480;
  if (frameCount <= 6) return 600;
  if (frameCount <= 12) return 760;
  return 900;
}

/** 一键拆分时派生卡片的网格布局参数。给 lib/frameSplit.ts + 旧调用方共用。 */
export const FRAME_GRID = {
  cols: 5,
  gapX: 16,
  gapY: 32,
  /** 第一行相对父卡的纵向偏移。 */
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

// ── 公共:合成卡 spawn ────────────────────────────────────────────────

export interface SpawnCompositeArgs {
  /** 帧路径 + 时间戳 + 序号 (顺序即排版顺序)。 */
  frames: FrameInput[];
  /** 锚点卡 — 合成卡相对它的下方放置,projectId 也跟它。 */
  anchorCard: CanvasCard;
  /** 卡片标题 — 默认 "关键帧合成"。 */
  title?: string;
  /** 合成元数据来源 — video 直接抽 / frame_extractor 智能分镜。 */
  source: { kind: "video" | "frame_extractor"; sourceCardId?: string };
}

/**
 * 调 composeFrameGrid 生成合成 PNG → 落库 + 入 store + 连线。返回新 card id。
 * 调用方负责 progress / toast / FrameExtractor 卡的 status 翻动。
 */
export async function spawnCompositeImageCard(
  args: SpawnCompositeArgs,
): Promise<string> {
  const { frames, anchorCard, title, source } = args;
  const cardStore = useCardStore.getState();
  const connStore = useConnectionStore.getState();

  // 1. 合成 PNG 落盘
  const result = await composeFrameGrid({
    frames,
    projectId: anchorCard.projectId,
    title: title ?? "关键帧合成",
  });

  // 2. 算卡片视觉尺寸 — 保持与合成图同 aspect,最长边按帧数动态。
  const maxEdge = compositeCardMaxEdge(frames.length);
  const cardAspect = result.width / result.height;
  let cardW: number;
  let cardH: number;
  if (cardAspect >= 1) {
    cardW = maxEdge;
    cardH = Math.round(maxEdge / cardAspect);
  } else {
    cardH = maxEdge;
    cardW = Math.round(maxEdge * cardAspect);
  }

  // 3. 位置:锚点卡下方,水平居中对齐
  const pos = {
    x: anchorCard.x + anchorCard.width / 2 - cardW / 2,
    y: anchorCard.y + anchorCard.height + FRAME_GRID.topOffset,
  };

  const now = new Date().toISOString();
  const compositeCard: CanvasCard = {
    id: crypto.randomUUID(),
    projectId: anchorCard.projectId,
    type: "ai_image",
    x: pos.x,
    y: pos.y,
    width: cardW,
    height: cardH,
    zIndex: cardStore.maxZIndex + 1,
    locked: false,
    collapsed: false,
    title: title ?? `关键帧合成 · ${frames.length} 张`,
    data: {
      imageUrl: result.imagePath,
      content: "",
      compositeFrames: frames,
      compositeLayout: result.layout,
      compositeSource: source,
    } satisfies CompositeImageData & Record<string, unknown>,
    createdAt: now,
    updatedAt: now,
  };

  const conn: Connection = {
    id: crypto.randomUUID(),
    projectId: anchorCard.projectId,
    sourceCardId: anchorCard.id,
    targetCardId: compositeCard.id,
    createdAt: now,
  };

  // 4. 落库 + 入 store (batch 一把过)
  await saveCardsBatch([cardToRow(compositeCard)]);
  await saveConnections(anchorCard.projectId, [connectionToRow(conn)]);
  cardStore.addCard(compositeCard);
  connStore.addConnection(conn);

  // 5. 节点数同步
  const count = cardStore.getCardsByProject(anchorCard.projectId).length;
  useProjectStore
    .getState()
    .updateProject(anchorCard.projectId, { nodeCount: count });
  void updateProjectMeta(anchorCard.projectId, { nodeCount: count });

  return compositeCard.id;
}

// ── 入口:智能分镜抽帧 + 合成 ────────────────────────────────────────

/**
 * 智能分镜抽帧主入口。
 *
 * 流程:
 *   1. 解析上游 chat 卡的分镜 JSON;
 *   2. ffmpeg 抽帧到磁盘;
 *   3. 合成一张 PNG → 落到 frame_extractor 下方为 ai_image 卡;
 *   4. 在 frame_extractor 卡上挂 compositeCardId 备查;
 *   5. 失败统一 toast + status="error"。
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

    // ── 2. 准备帧列表(继承 shot.description / shot_type 作 title) ──
    const frames: FrameInput[] = parsed.shots.map((shot, i) => ({
      framePath: framePaths[i]!,
      timestamp: shot.keyframe_timestamp,
      index: shot.index,
      title:
        `分镜 ${shot.index} · ${formatTimestamp(shot.keyframe_timestamp)}` +
        (shot.shot_type ? ` · ${shot.shot_type}` : ""),
    }));

    // ── 3. 合成 + 派生 ai_image 卡 ──
    const compositeCardId = await spawnCompositeImageCard({
      frames,
      anchorCard: card,
      title: `关键帧合成 · ${frames.length} 张`,
      source: { kind: "frame_extractor", sourceCardId: card.id },
    });

    // ── 4. 更新提取器卡状态 ──
    cardStore.updateCardData(extractorCardId, {
      status: "done",
      compositeCardId,
      lastFrameCount: frames.length,
      errorMessage: undefined,
    } satisfies Partial<FrameExtractorData>);
    autoSave.markDirty(extractorCardId);

    // ── 5. 选中合成卡,引导用户视线 ──
    useCanvasStore.getState().setSelectedCardIds([compositeCardId]);

    uiStore.addToast({
      type: "info",
      title: `已合成 ${frames.length} 张关键帧`,
      description: "在合成图卡上点「拆分」可拆成独立帧卡。",
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
