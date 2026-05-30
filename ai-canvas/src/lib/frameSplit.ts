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
    // 选中所有子卡方便用户找到它们
    const canvas = await import("@/stores/canvasStore");
    canvas.useCanvasStore.getState().setSelectedCardIds(existingIds);
    return;
  }

  try {
    // 子卡 size:基于合成卡里单格的 aspect = compositeLayout.cols * compositeLayout.rows
    // 的视觉占比反推。退而求 16:9 兜底。
    const layout = data.compositeLayout ?? { cols: 1, rows: 1 };
    const cellAspect =
      layout.cols > 0 && layout.rows > 0
        ? (card.width / layout.cols) / (card.height / layout.rows)
        : 16 / 9;
    const size = frameCardSize(cellAspect);

    const { cols, gapX, gapY, topOffset } = FRAME_GRID;
    const anchor = { x: card.x, y: card.y + card.height + topOffset };

    let zCursor = cardStore.maxZIndex;
    const now = new Date().toISOString();
    const newCards: CanvasCard[] = [];
    const newConns: Connection[] = [];

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
    let placed = 0;

    for (const frame of todo) {
      zCursor += 1;
      const childId = crypto.randomUUID();
      const pos = {
        x: anchor.x + (placed % cols) * (size.width + gapX),
        y: anchor.y + Math.floor(placed / cols) * (size.height + gapY),
      };
      placed += 1;

      const title =
        frame.title ?? `帧 ${frame.index} · ${formatTimestamp(frame.timestamp)}`;

      newCards.push({
        id: childId,
        projectId: card.projectId,
        type: "ai_image",
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        zIndex: zCursor,
        locked: false,
        collapsed: false,
        title,
        data: {
          imageUrl: frame.framePath,
          content: "",
          // 血缘元数据 — 与 frameExtraction 派生卡保持一致
          sourceCompositeCardId: card.id,
          sourceFrameIndex: frame.index,
          sourceTimestamp: frame.timestamp,
        },
        createdAt: now,
        updatedAt: now,
      });

      newConns.push({
        id: crypto.randomUUID(),
        projectId: card.projectId,
        sourceCardId: card.id,
        targetCardId: childId,
        createdAt: now,
      });
    }

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
    for (const cn of newConns) connStore.addConnection(cn);

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
