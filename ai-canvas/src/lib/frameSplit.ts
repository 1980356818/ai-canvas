//! 关键帧合成图的"一键拆分" — 把 ai_image 卡上挂的 compositeFrames 还原成
//! 独立 ai_image 卡片,并自动建立 composite → 子卡 的连线。
//!
//! 设计:
//!   - 不删除合成卡(用户答 "保留"),只在下方铺一组子卡;
//!   - 已拆过的合成卡再点拆分 = no-op + toast,避免重复出图;
//!   - 子卡按照 FRAME_GRID 排版与既有 frame_extractor 派生卡视觉对齐。

import { useCardStore } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { useProjectStore } from "@/stores/projectStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { saveCardsBatch, saveConnections, updateProjectMeta } from "@/platform";
import { cardToRow, connectionToRow } from "@/lib/mappers";
import { autoSave } from "@/lib/autoSave";
import { FRAME_GRID, frameCardSize, formatTimestamp } from "@/lib/frameExtraction";
import type { FrameInput } from "@/lib/frameComposite";
import type { CanvasCard, Connection } from "@/types";

// ── 类型:挂在 ai_image.data 上的合成元数据 ───────────────────────────

export interface CompositeImageData {
  /** N 张源帧的归档信息,用于拆分还原。 */
  compositeFrames?: FrameInput[];
  /** 排版网格快照,供 UI/导出时复用。 */
  compositeLayout?: { cols: number; rows: number };
  /** 抽帧来源 — 视频卡 / FrameExtractor 卡 id,便于回溯。 */
  compositeSource?: {
    kind: "video" | "frame_extractor";
    sourceCardId?: string;
  };
  /** 拆分后给子卡 id 数组,二次点击拆分时跳过(避免重复)。 */
  compositeDerivedCardIds?: string[];
}

// ── 内部:派生卡 + 连线工厂 ───────────────────────────────────────────

/** 单帧子卡构造的契约集中点 — splitCompositeImage(批量) 和 spawnSingleFrameCard(单张)共用,
 *  避免血缘字段 / size 计算在两处漂移。 */
interface BuildChildFrameOptions {
  composite: CanvasCard;
  frame: FrameInput;
  cellAspect: number;
  /** 子卡左上角(画布坐标)。批量拆分按 grid 算,单张拖出按 mouse 中心算。 */
  position: { x: number; y: number };
  zIndex: number;
  createdAt: string;
}

function buildChildFrameCard(
  opts: BuildChildFrameOptions,
): { card: CanvasCard; conn: Connection } {
  const { composite, frame, cellAspect, position, zIndex, createdAt } = opts;
  const size = frameCardSize(cellAspect);

  const card: CanvasCard = {
    id: crypto.randomUUID(),
    projectId: composite.projectId,
    type: "ai_image",
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
    zIndex,
    locked: false,
    collapsed: false,
    title: frame.title ?? `帧 ${frame.index} · ${formatTimestamp(frame.timestamp)}`,
    data: {
      imageUrl: frame.framePath,
      content: "",
      sourceCompositeCardId: composite.id,
      sourceFrameIndex: frame.index,
      sourceTimestamp: frame.timestamp,
    },
    createdAt,
    updatedAt: createdAt,
  };

  const conn: Connection = {
    id: crypto.randomUUID(),
    projectId: composite.projectId,
    sourceCardId: composite.id,
    targetCardId: card.id,
    createdAt,
  };

  return { card, conn };
}

/** 从合成卡的尺寸 + layout 反推单格 aspect,兜底 16:9。 */
function deriveCellAspect(composite: CanvasCard, layout: { cols: number; rows: number }): number {
  if (layout.cols <= 0 || layout.rows <= 0) return 16 / 9;
  return (composite.width / layout.cols) / (composite.height / layout.rows);
}

// ── 入口 ──────────────────────────────────────────────────────────────

/**
 * 把指定合成卡拆成 N 张独立 ai_image 卡,排布在合成卡下方。
 *
 * - 子卡 size 用 `frameCardSize(cellAspect)`,与 frame_extractor 派生卡一致;
 * - 自动建立合成 → 每张子卡的连线;
 * - 在合成卡 `data.compositeDerivedCardIds` 上挂子卡 id,重复点击不重生;
 * - 已存在的子卡(被用户保留)→ 跳过,只补还没生成的。
 */
export async function splitCompositeImage(
  compositeCardId: string,
): Promise<void> {
  const cardStore = useCardStore.getState();
  const uiStore = useUIStore.getState();
  const connStore = useConnectionStore.getState();

  const card = cardStore.getCard(compositeCardId);
  if (!card || card.type !== "ai_image") {
    uiStore.addToast({
      type: "error",
      title: "拆分失败",
      description: "找不到合成图卡片",
      duration: 4000,
    });
    return;
  }

  const data = card.data as CompositeImageData & Record<string, unknown>;
  const frames = data.compositeFrames ?? [];
  if (frames.length === 0) {
    uiStore.addToast({
      type: "info",
      title: "无法拆分",
      description: "该图片不是关键帧合成图",
      duration: 3000,
    });
    return;
  }

  // 已存在子卡 ↦ 跳过,只补缺。
  const existingIds = (data.compositeDerivedCardIds ?? []).filter((id) =>
    cardStore.getCard(id),
  );
  if (existingIds.length === frames.length) {
    uiStore.addToast({
      type: "info",
      title: "已拆分过,无新增帧",
      duration: 2500,
    });
    useCanvasStore.getState().setSelectedCardIds(existingIds);
    return;
  }

  try {
    const layout = data.compositeLayout ?? { cols: 1, rows: 1 };
    const cellAspect = deriveCellAspect(card, layout);
    const sampleSize = frameCardSize(cellAspect);

    const { cols, gapX, gapY, topOffset } = FRAME_GRID;
    const anchor = { x: card.x, y: card.y + card.height + topOffset };

    // 已派生帧的 index 集合 — 跳过它们,只补缺。
    const derivedFrameIndices = new Set<number>();
    for (const id of existingIds) {
      const c = cardStore.getCard(id);
      const d = (c?.data ?? {}) as { sourceFrameIndex?: number };
      if (typeof d.sourceFrameIndex === "number") {
        derivedFrameIndices.add(d.sourceFrameIndex);
      }
    }

    const todo = frames.filter((f) => !derivedFrameIndices.has(f.index));
    const now = new Date().toISOString();
    const newCards: CanvasCard[] = [];
    const newConns: Connection[] = [];
    let zCursor = cardStore.maxZIndex;

    todo.forEach((frame, placed) => {
      zCursor += 1;
      const position = {
        x: anchor.x + (placed % cols) * (sampleSize.width + gapX),
        y: anchor.y + Math.floor(placed / cols) * (sampleSize.height + gapY),
      };
      const built = buildChildFrameCard({
        composite: card,
        frame,
        cellAspect,
        position,
        zIndex: zCursor,
        createdAt: now,
      });
      newCards.push(built.card);
      newConns.push(built.conn);
    });

    if (newCards.length === 0) {
      uiStore.addToast({
        type: "info",
        title: "没有需要新生成的子卡",
        duration: 2500,
      });
      return;
    }

    // 批量落库 + 入 store
    await saveCardsBatch(newCards.map(cardToRow));
    await saveConnections(card.projectId, newConns.map(connectionToRow));
    for (const c of newCards) cardStore.addCard(c);
    connStore.addConnections(newConns);

    // 在合成卡上挂派生 id,避免下次重生
    const updatedDerivedIds = [
      ...existingIds,
      ...newCards.map((c) => c.id),
    ];
    cardStore.updateCardData(card.id, {
      compositeDerivedCardIds: updatedDerivedIds,
    } satisfies Partial<CompositeImageData>);
    autoSave.markDirty(card.id);

    // 节点数同步
    const count = cardStore.getCardsByProject(card.projectId).length;
    useProjectStore
      .getState()
      .updateProject(card.projectId, { nodeCount: count });
    void updateProjectMeta(card.projectId, { nodeCount: count });

    uiStore.addToast({
      type: "info",
      title: `已拆分 ${newCards.length} 张关键帧`,
      duration: 2500,
    });
  } catch (err) {
    uiStore.addToast({
      type: "error",
      title: "拆分失败",
      description: err instanceof Error ? err.message : String(err),
      duration: 5000,
    });
  }
}

// ── 入口:单帧拖出 ────────────────────────────────────────────────────

/**
 * 从合成卡里抽一张帧 → 新建独立 ai_image 卡到 `dropCanvasPos`(以鼠标为中心)。
 *
 * 与 splitCompositeImage 的区别:
 *   - 不查重不跳过 — 同一帧多拖几次就生成几张子卡(用户可能想用不同 prompt 派生变体);
 *   - 位置以鼠标落点为中心,不走 FRAME_GRID 排版;
 *   - 仍把新 id append 到 compositeDerivedCardIds,血缘记录保持完整。
 */
export async function spawnSingleFrameCard(
  compositeCardId: string,
  frameIndex: number,
  dropCanvasPos: { x: number; y: number },
): Promise<void> {
  const cardStore = useCardStore.getState();
  const uiStore = useUIStore.getState();
  const connStore = useConnectionStore.getState();

  const composite = cardStore.getCard(compositeCardId);
  if (!composite || composite.type !== "ai_image") {
    uiStore.addToast({ type: "error", title: "抽帧失败", description: "找不到合成卡", duration: 4000 });
    return;
  }

  const data = composite.data as CompositeImageData & Record<string, unknown>;
  const frame = data.compositeFrames?.find((f) => f.index === frameIndex);
  if (!frame) {
    uiStore.addToast({ type: "error", title: "抽帧失败", description: "该格没有可用帧", duration: 4000 });
    return;
  }

  try {
    const layout = data.compositeLayout ?? { cols: 1, rows: 1 };
    const cellAspect = deriveCellAspect(composite, layout);
    const sampleSize = frameCardSize(cellAspect);

    const built = buildChildFrameCard({
      composite,
      frame,
      cellAspect,
      position: {
        x: dropCanvasPos.x - sampleSize.width / 2,
        y: dropCanvasPos.y - sampleSize.height / 2,
      },
      zIndex: cardStore.maxZIndex + 1,
      createdAt: new Date().toISOString(),
    });

    await saveCardsBatch([cardToRow(built.card)]);
    await saveConnections(composite.projectId, [connectionToRow(built.conn)]);
    cardStore.addCard(built.card);
    connStore.addConnection(built.conn);

    const updatedDerivedIds = [...(data.compositeDerivedCardIds ?? []), built.card.id];
    cardStore.updateCardData(composite.id, {
      compositeDerivedCardIds: updatedDerivedIds,
    } satisfies Partial<CompositeImageData>);
    autoSave.markDirty(composite.id);

    const count = cardStore.getCardsByProject(composite.projectId).length;
    useProjectStore.getState().updateProject(composite.projectId, { nodeCount: count });
    void updateProjectMeta(composite.projectId, { nodeCount: count });

    useCanvasStore.getState().setSelectedCardIds([built.card.id]);
  } catch (err) {
    uiStore.addToast({
      type: "error",
      title: "抽帧失败",
      description: err instanceof Error ? err.message : String(err),
      duration: 5000,
    });
  }
}

// ── 查询工具 ──────────────────────────────────────────────────────────

/** 判断一张 ai_image 卡是否带可拆分的合成元数据。供 UI 决定是否露 "拆分" 按钮。 */
export function isCompositeImage(card: CanvasCard): boolean {
  if (card.type !== "ai_image") return false;
  const frames = (card.data as CompositeImageData).compositeFrames;
  return Array.isArray(frames) && frames.length >= 2;
}

/** 合成卡里待拆分的剩余张数(已派生 + 仍存活的不计入)。 */
export function pendingSplitCount(card: CanvasCard): number {
  if (!isCompositeImage(card)) return 0;
  const data = card.data as CompositeImageData;
  const total = data.compositeFrames?.length ?? 0;
  const existing = (data.compositeDerivedCardIds ?? []).filter((id) =>
    useCardStore.getState().getCard(id),
  ).length;
  return Math.max(0, total - existing);
}
