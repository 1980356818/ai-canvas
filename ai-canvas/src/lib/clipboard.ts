import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import {
  useConnectionStore,
  type Connection,
} from "@/stores/connectionStore";
import { useProjectStore } from "@/stores/projectStore";
import { useGroupStore } from "@/stores/groupStore";
import { useUIStore } from "@/stores/uiStore";
import { clipboardWriteText, clipboardReadText, updateProjectMeta, saveGroupsBatch } from "@/platform";
import { autoSave } from "@/lib/autoSave";
import { recordBatchCreate } from "@/lib/history";
import { groupToRow } from "@/lib/mappers";
import { DEFAULT_GROUP_COLOR } from "@/types/group";
import type { CardGroup } from "@/types";
import {
  cleanupDanglingReferencesInCards,
  cleanupDanglingReferencesInStore,
} from "@/lib/referenceConsistency";

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

export async function copyCards(cardIds: Set<string>): Promise<number> {
  if (cardIds.size === 0) return 0;

  const { cards, connections, groups } = collectSelected(cardIds);
  if (cards.length === 0) return 0;

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
  try {
    await clipboardWriteText(text);
    useUIStore.getState().addToast({
      type: "info",
      title: `已复制 ${cards.length} 张卡片${extras}`,
      duration: 1500,
    });
  } catch (e) {
    console.error("[clipboard.copyCards] write failed, in-memory fallback only", e);
    useUIStore.getState().addToast({
      type: "info",
      title: `已复制 ${cards.length} 张卡片${extras}（应用内）`,
      duration: 1500,
    });
  }
  return cards.length;
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

// ---------------------------------------------------------------------------
// Materialize: turn a payload into real cards + connections
// ---------------------------------------------------------------------------

function materialize(
  payload: ClipboardPayload,
  projectId: string,
  position?: PastePosition,
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
  recordBatchCreate(newCardIds);

  // Defense-in-depth: refs are already stripped at copy time by collectSelected(),
  // but external clipboard payloads or older formats may still carry stale refs.
  cleanupDanglingReferencesInStore({ cardIds: newCardIds });

  return newCardIds;
}
