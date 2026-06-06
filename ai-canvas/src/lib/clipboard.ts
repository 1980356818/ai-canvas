import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import {
  useConnectionStore,
  type Connection,
} from "@/stores/connectionStore";
import { useProjectStore } from "@/stores/projectStore";
import { useGroupStore } from "@/stores/groupStore";
import { useUIStore } from "@/stores/uiStore";
import { clipboardWriteText, clipboardReadText, updateProjectMeta, saveGroupsBatch, deleteCard } from "@/platform";
import { autoSave } from "@/lib/autoSave";
import { recordBatchCreate, recordMove } from "@/lib/history";
import { groupToRow } from "@/lib/mappers";
import { DEFAULT_GROUP_COLOR } from "@/types/group";
import type { CardGroup } from "@/types";
import {
  cleanupDanglingReferencesInCards,
  cleanupDanglingReferencesInStore,
  removeConnectionsForCardIdsAndCleanup,
} from "@/lib/referenceConsistency";
import { pruneGroupsForRemovedCards } from "@/lib/groupConsistency";

// v3 增加 groups 字段;v2/v1 仍可读(无 groups)
const CLIPBOARD_KIND = "ai-canvas-card/v3";
const CLIPBOARD_KIND_V2 = "ai-canvas-card/v2";
const CLIPBOARD_KIND_V1 = "ai-canvas-card/v1";

let inMemoryClipboard: string | null = null;

/** 剪贴板上承载的组快照(去掉 id/时间戳/projectId,粘贴时新建)。 */
interface ClipboardGroup {
  /** 原 group id,用来在 payload 内部把 cardIds 关联起来(paste 时不复用)。 */
  refId: string;
  title: string;
  color: string;
  collapsed: boolean;
  /** 原 cardIds,paste 时通过 idMap 映射到新 id。 */
  cardIds: string[];
}

interface ClipboardPayload {
  kind: string;
  cards: CanvasCard[];
  connections: Connection[];
  groups?: ClipboardGroup[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function syncNodeCount(projectId: string) {
  const count = useCardStore.getState().getCardsByProject(projectId).length;
  const updatedAt = new Date().toISOString();
  useProjectStore.getState().updateProject(projectId, { nodeCount: count, updatedAt });
  void updateProjectMeta(projectId, { nodeCount: count });
}

// ---------------------------------------------------------------------------
// Core: collect
// ---------------------------------------------------------------------------

export function collectSelected(cardIds: Set<string>): {
  cards: CanvasCard[];
  connections: Connection[];
  groups: ClipboardGroup[];
} {
  const cardStore = useCardStore.getState();
  const cards: CanvasCard[] = [];
  for (const id of cardIds) {
    const c = cardStore.getCard(id);
    if (c) cards.push(c);
  }

  // Only keep connections whose BOTH ends are in the copy set
  const connections: Connection[] = [];
  for (const conn of useConnectionStore.getState().connections.values()) {
    if (cardIds.has(conn.sourceCardId) && cardIds.has(conn.targetCardId)) {
      connections.push(conn);
    }
  }

  // 组复制语义:只复制"selection 完全包住"的组,部分选中的组不带组结构。
  // 这样避免"复制半个组"产生粘贴后的不完整组身份。
  const groups: ClipboardGroup[] = [];
  const groupStore = useGroupStore.getState();
  for (const g of groupStore.groups.values()) {
    const allIn = g.cardIds.every((cid) => cardIds.has(cid));
    if (!allIn) continue;
    groups.push({
      refId: g.id,
      title: g.title,
      color: g.color,
      collapsed: g.collapsed,
      cardIds: [...g.cardIds],
    });
  }

  // Strip connection-derived references (refImages, upstreamTexts, etc.) whose
  // source card is NOT included in the copy set. This ensures the clipboard
  // payload only carries "owned" data; connection-injected data will be
  // re-populated by the onConnectionsAdded lifecycle hook when connections are
  // recreated at paste time.
  const { cards: cleanedCards } = cleanupDanglingReferencesInCards(cards, connections);

  return { cards: cleanedCards, connections, groups };
}

// ---------------------------------------------------------------------------
// Core: parse clipboard text -> payload
// ---------------------------------------------------------------------------

export function parseClipboard(text: string): ClipboardPayload | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }

  const kind = parsed.kind as string | undefined;
  if (
    kind !== CLIPBOARD_KIND &&
    kind !== CLIPBOARD_KIND_V2 &&
    kind !== CLIPBOARD_KIND_V1
  ) {
    return null;
  }

  let cards: CanvasCard[];
  if (Array.isArray(parsed.cards)) {
    cards = parsed.cards as CanvasCard[];
  } else if (parsed.card && typeof parsed.card === "object") {
    cards = [parsed.card as CanvasCard];
  } else {
    return null;
  }

  const connections: Connection[] = Array.isArray(parsed.connections)
    ? (parsed.connections as Connection[])
    : [];

  const groups: ClipboardGroup[] = Array.isArray(parsed.groups)
    ? (parsed.groups as ClipboardGroup[])
    : [];

  return { kind: CLIPBOARD_KIND, cards, connections, groups };
}

// ---------------------------------------------------------------------------
// High-level: copy
// ---------------------------------------------------------------------------

/**
 * 把选中卡片序列化写进剪贴板(系统剪贴板 + 内存兜底),copy / cut 共用。
 * 返回写入的卡片数与「N 条连线 / M 个组」描述串;系统写失败时仅留内存兜底(不抛)。
 */
async function writeSelectionToClipboard(cardIds: Set<string>): Promise<{
  count: number;
  extras: string;
  systemOk: boolean;
}> {
  const { cards, connections, groups } = collectSelected(cardIds);
  if (cards.length === 0) return { count: 0, extras: "", systemOk: false };

  const payload: ClipboardPayload = {
    kind: CLIPBOARD_KIND,
    cards,
    connections,
    groups: groups.length > 0 ? groups : undefined,
  };
  const text = JSON.stringify(payload);
  inMemoryClipboard = text;

  const parts: string[] = [];
  if (connections.length > 0) parts.push(`${connections.length} 条连线`);
  if (groups.length > 0) parts.push(`${groups.length} 个组`);
  const extras = parts.length > 0 ? `和 ${parts.join(" / ")}` : "";

  let systemOk = true;
  try {
    await clipboardWriteText(text);
  } catch (e) {
    systemOk = false;
    console.error("[clipboard] system write failed, in-memory fallback only", e);
  }
  return { count: cards.length, extras, systemOk };
}

export async function copyCards(cardIds: Set<string>): Promise<number> {
  if (cardIds.size === 0) return 0;

  // 复制别的内容 → 取消任何「待移动」的剪切(原卡保留在画布上,不再隐式移动)。
  useCanvasStore.getState().clearCutCards();

  const { count, extras, systemOk } = await writeSelectionToClipboard(cardIds);
  if (count === 0) return 0;

  useUIStore.getState().addToast({
    type: "info",
    title: `已复制 ${count} 张卡片${extras}${systemOk ? "" : "（应用内）"}`,
    duration: 1500,
  });
  return count;
}

/**
 * 剪切 = 写剪贴板快照 + 标记「待移动」,但**不删除**卡片(延迟删除,仿资源管理器)。
 * 真正删除发生在下次粘贴时(见 pasteCards 的移动分支)。在此之前任何复制 / 再剪切 /
 * Esc / 删除都会取消这次剪切,原卡始终安全留在画布上 —— 绝不会因为「剪切后又复制别的
 * 图片」而丢卡。
 */
export async function cutCards(cardIds: Set<string>): Promise<number> {
  if (cardIds.size === 0) return 0;
  const projectId = useProjectStore.getState().currentProjectId;
  if (!projectId) return 0;

  // 先取消上一次未完成的剪切,再登记这次
  useCanvasStore.getState().clearCutCards();

  const { count, extras, systemOk } = await writeSelectionToClipboard(cardIds);
  if (count === 0) return 0;

  useCanvasStore.getState().setCutCards([...cardIds], projectId);
  useUIStore.getState().addToast({
    type: "info",
    title: `已剪切 ${count} 张卡片${extras}，粘贴后移动${systemOk ? "" : "（应用内）"}`,
    duration: 1500,
  });
  return count;
}

// ---------------------------------------------------------------------------
// High-level: paste
// ---------------------------------------------------------------------------

export interface PastePosition {
  worldX: number;
  worldY: number;
}

export async function pasteCards(
  projectId: string,
  position?: PastePosition,
): Promise<string[]> {
  const canvas = useCanvasStore.getState();
  const cutIds = canvas.cutCardIds;

  // ── 剪切 → 粘贴 = 移动 ──
  // 重新采集「当前」的剪切卡(保留剪切后的任何编辑),在落点重建,然后才删除原卡。
  // 原卡此刻才离开画布 —— 在这之前它一直安全;若中途已被删/清空则退回普通粘贴。
  if (cutIds.size > 0) {
    const live = collectSelected(cutIds);
    if (live.cards.length > 0) {
      const payload: ClipboardPayload = {
        kind: CLIPBOARD_KIND,
        cards: live.cards,
        connections: live.connections,
        groups: live.groups.length > 0 ? live.groups : undefined,
      };
      // 原卡快照(此刻连线仍在),用于把「新建 + 删除」合成单步撤销
      const srcCards: CanvasCard[] = [];
      for (const id of cutIds) {
        const c = useCardStore.getState().getCard(id);
        if (c) srcCards.push({ ...c });
      }
      const newCardIds = materialize(payload, projectId, position, false);
      recordMove(newCardIds, srcCards);
      deleteOriginalsAfterMove([...cutIds]);
      const srcPid = canvas.cutSourceProjectId;
      useCanvasStore.getState().clearCutCards();
      // materialize 内部已 sync 过 target,但删原卡后计数又变,需再 sync 一次。
      syncNodeCount(projectId);
      if (srcPid && srcPid !== projectId) syncNodeCount(srcPid);
      return newCardIds;
    }
    // 剪切卡已不在(被删 / 项目切换清空)→ 取消剪切,退回普通粘贴(剪贴板快照仍可用)
    useCanvasStore.getState().clearCutCards();
  }

  let text = "";
  try {
    text = await clipboardReadText();
  } catch (e) {
    console.error("[clipboard.pasteCards] read failed, will try in-memory", e);
  }

  let payload = parseClipboard(text);
  if (!payload && inMemoryClipboard) {
    console.warn("[clipboard.pasteCards] system clipboard miss, using in-memory fallback");
    payload = parseClipboard(inMemoryClipboard);
  }
  if (!payload) {
    useUIStore.getState().addToast({
      type: "warning",
      title: "剪贴板里没有可粘贴的卡片",
      duration: 2000,
    });
    return [];
  }

  return materialize(payload, projectId, position);
}

/**
 * 移动语义下删除原卡:清连线 + 删卡(store + DB) + 整理组。
 * 撤销已由调用方的 recordMove 负责,这里不再 record —— 故须在 recordMove **之后**调用。
 */
function deleteOriginalsAfterMove(ids: string[]) {
  if (ids.length === 0) return;
  removeConnectionsForCardIdsAndCleanup(ids);
  for (const id of ids) {
    useCardStore.getState().removeCard(id);
    void deleteCard(id).catch(() => {
      /* backend may be unavailable; autoSave will reconcile */
    });
  }
  pruneGroupsForRemovedCards(ids);
  autoSave.markDirty();
}

// ---------------------------------------------------------------------------
// Materialize: turn a payload into real cards + connections
// ---------------------------------------------------------------------------

function materialize(
  payload: ClipboardPayload,
  projectId: string,
  position?: PastePosition,
  recordHistory = true,
): string[] {
  const { cards: srcCards, connections: srcConns } = payload;
  if (srcCards.length === 0) return [];

  const now = new Date().toISOString();
  const idMap = new Map<string, string>();
  const newCardIds: string[] = [];

  // Compute offset: either fixed +30px or reposition group center to click point
  let offsetX = 30;
  let offsetY = 30;
  if (position) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of srcCards) {
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x + c.width);
      maxY = Math.max(maxY, c.y + c.height);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    offsetX = position.worldX - cx;
    offsetY = position.worldY - cy;
  }

  // Sort source cards by zIndex to preserve relative ordering
  const sorted = [...srcCards].sort((a, b) => a.zIndex - b.zIndex);

  for (const src of sorted) {
    const newId = crypto.randomUUID();
    idMap.set(src.id, newId);

    const { maxZIndex } = useCardStore.getState();
    const card: CanvasCard = {
      ...src,
      id: newId,
      projectId,
      x: src.x + offsetX,
      y: src.y + offsetY,
      zIndex: maxZIndex + 1,
      createdAt: now,
      updatedAt: now,
    };
    useCardStore.getState().addCard(card);
    autoSave.markDirty(newId);
    newCardIds.push(newId);
  }

  // Recreate connections with remapped IDs
  for (const src of srcConns) {
    const newSourceId = idMap.get(src.sourceCardId);
    const newTargetId = idMap.get(src.targetCardId);
    if (!newSourceId || !newTargetId) continue;

    const conn: Connection = {
      id: crypto.randomUUID(),
      projectId,
      sourceCardId: newSourceId,
      targetCardId: newTargetId,
      createdAt: now,
    };
    useConnectionStore.getState().addConnection(conn);
  }

  // Recreate groups with remapped IDs(只重建 selection 完整包住的组,parseClipboard 已保证)
  const srcGroups = payload.groups ?? [];
  if (srcGroups.length > 0) {
    const groupStore = useGroupStore.getState();
    for (const sg of srcGroups) {
      const mapped = sg.cardIds
        .map((cid) => idMap.get(cid))
        .filter((id): id is string => !!id);
      if (mapped.length < 2) continue; // 跳过残缺组
      const newGroup: CardGroup = {
        id: crypto.randomUUID(),
        projectId,
        cardIds: mapped,
        title: sg.title ?? "新建组",
        color: sg.color ?? DEFAULT_GROUP_COLOR,
        collapsed: !!sg.collapsed,
        createdAt: now,
        updatedAt: now,
      };
      groupStore.addGroup(newGroup);
    }
    const all = groupStore.getGroupsByProject(projectId);
    void saveGroupsBatch(all.map(groupToRow)).catch((e) =>
      console.warn("[clipboard.materialize] saveGroupsBatch failed:", e),
    );
  }

  syncNodeCount(projectId);
  useCanvasStore.getState().setSelectedCardIds(newCardIds);
  // 移动路径(recordHistory=false)由调用方用 recordMove 合成「新建+删除」单步撤销。
  if (recordHistory) recordBatchCreate(newCardIds);

  // Defense-in-depth: refs are already stripped at copy time by collectSelected(),
  // but external clipboard payloads or older formats may still carry stale refs.
  cleanupDanglingReferencesInStore({ cardIds: newCardIds });

  return newCardIds;
}
