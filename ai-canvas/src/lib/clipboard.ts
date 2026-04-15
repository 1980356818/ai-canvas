import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import {
  useConnectionStore,
  type Connection,
} from "@/stores/connectionStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { clipboardWriteText, clipboardReadText, updateProjectMeta } from "@/lib/tauri";
import { autoSave } from "@/lib/autoSave";
import { injectOnConnect } from "@/lib/dataFlow";
import { recordBatchCreate } from "@/lib/history";

const CLIPBOARD_KIND = "ai-canvas-card/v2";
const CLIPBOARD_KIND_V1 = "ai-canvas-card/v1";

interface ClipboardPayload {
  kind: string;
  cards: CanvasCard[];
  connections: Connection[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function syncNodeCount(projectId: string) {
  const count = useCardStore.getState().getCardsByProject(projectId).length;
  useProjectStore.getState().updateProject(projectId, { nodeCount: count });
  void updateProjectMeta(projectId, { nodeCount: count });
}

function createTextCard(projectId: string, content: string): CanvasCard {
  const vp = useCanvasStore.getState().viewport;
  const cx = (-vp.x + vp.width / 2) / vp.zoom;
  const cy = (-vp.y + vp.height / 2) / vp.zoom;
  const { maxZIndex } = useCardStore.getState();
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    projectId,
    type: "text",
    x: cx - 160,
    y: cy - 120,
    width: 320,
    height: 240,
    zIndex: maxZIndex + 1,
    locked: false,
    collapsed: false,
    data: { content },
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Core: collect
// ---------------------------------------------------------------------------

export function collectSelected(cardIds: Set<string>): {
  cards: CanvasCard[];
  connections: Connection[];
} {
  const cardStore = useCardStore.getState();
  const cards: CanvasCard[] = [];
  for (const id of cardIds) {
    const c = cardStore.getCard(id);
    if (c) cards.push(c);
  }

  const connections: Connection[] = [];
  for (const conn of useConnectionStore.getState().connections.values()) {
    if (cardIds.has(conn.sourceCardId) && cardIds.has(conn.targetCardId)) {
      connections.push(conn);
    }
  }

  return { cards, connections };
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
  if (kind !== CLIPBOARD_KIND && kind !== CLIPBOARD_KIND_V1) return null;

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

  return { kind: CLIPBOARD_KIND, cards, connections };
}

// ---------------------------------------------------------------------------
// High-level: copy
// ---------------------------------------------------------------------------

export async function copyCards(cardIds: Set<string>): Promise<number> {
  if (cardIds.size === 0) return 0;

  const { cards, connections } = collectSelected(cardIds);
  if (cards.length === 0) return 0;

  const payload: ClipboardPayload = { kind: CLIPBOARD_KIND, cards, connections };
  try {
    await clipboardWriteText(JSON.stringify(payload));
    const connMsg = connections.length > 0 ? `和 ${connections.length} 条连线` : "";
    useUIStore.getState().addToast({
      type: "info",
      title: `已复制 ${cards.length} 张卡片${connMsg}`,
      duration: 1500,
    });
  } catch {
    /* clipboard denied */
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
  let text: string;
  try {
    text = await clipboardReadText();
  } catch {
    return [];
  }

  const payload = parseClipboard(text);

  if (!payload) {
    if (!text.trim()) return [];
    const card = createTextCard(projectId, text);
    useCardStore.getState().addCard(card);
    autoSave.markDirty(card.id);
    syncNodeCount(projectId);
    useCanvasStore.getState().setSelectedCardIds([card.id]);
    return [card.id];
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
    injectOnConnect(newSourceId, newTargetId);
  }

  syncNodeCount(projectId);
  useCanvasStore.getState().setSelectedCardIds(newCardIds);
  recordBatchCreate(newCardIds);

  return newCardIds;
}
