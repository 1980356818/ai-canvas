import type { CanvasCard, Connection } from "@/types";
import type { RefImageEntry } from "@/config/model-ref-images";
import type { InlineImageRef } from "@/lib/promptSerializer";
import { useCardStore } from "@/stores/cardStore";
import { useConnectionStore, setConnectionLifecycleHooks } from "@/stores/connectionStore";
import { autoSave } from "@/lib/autoSave";
import { injectOnConnections } from "@/lib/dataFlow";

interface SourceRef {
  sourceCardId?: string;
}

interface VideoFrameRef extends SourceRef {
  url: string;
}

interface MediaEntry extends SourceRef {
  url: string;
  displayUrl?: string;
  kind?: string;
}

interface CleanupResult {
  data: Record<string, unknown>;
  changed: boolean;
}

export interface CleanupSummary {
  changedCardIds: string[];
}

function withoutUndefinedFields(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

function connectionKey(sourceCardId: string, targetCardId: string): string {
  return `${sourceCardId}\u2192${targetCardId}`;
}

export function buildValidConnectionKeys(
  connections: Iterable<Connection>,
  existingCardIds?: Set<string>,
): Set<string> {
  const keys = new Set<string>();
  for (const conn of connections) {
    if (existingCardIds) {
      if (!existingCardIds.has(conn.sourceCardId) || !existingCardIds.has(conn.targetCardId)) {
        continue;
      }
    }
    keys.add(connectionKey(conn.sourceCardId, conn.targetCardId));
  }
  return keys;
}

function hasValidConnection(
  validConnectionKeys: Set<string>,
  sourceCardId: string | undefined,
  targetCardId: string,
): boolean {
  return !!sourceCardId && validConnectionKeys.has(connectionKey(sourceCardId, targetCardId));
}

// v5：旧的 `sameData(a, b)` 用 `JSON.stringify(a) === JSON.stringify(b)` 做
// deep-equal，对含 base64 / 长 prompt 的 `card.data` 是 O(2N) + 字符串比较。
// 已删除——下面 `cleanupDanglingReferencesForCard` 仅在自身设的 `changed`
// 为 true 时返回新对象，调用方 `diffDataPatch` 会再做 shallow key-diff，
// 而 `updateCardData` 内部对每个 patch 字段做 `merged[key] !== next` 短路，
// 三层兜底保证"无实际变化时不触发下游 watcher"，stringify 完全冗余。

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getSourceCardIdFromInlineRef(ref: InlineImageRef): string | undefined {
  return ref.source.type === "upstream" ? ref.source.sourceCardId : undefined;
}

function isInlineRefStillValid(
  ref: InlineImageRef,
  data: Record<string, unknown>,
  targetCardId: string,
  validConnectionKeys: Set<string>,
): boolean {
  switch (ref.source.type) {
    case "upstream":
      return hasValidConnection(validConnectionKeys, ref.source.sourceCardId, targetCardId);

    case "refSlot": {
      const refImages = data.refImages as Record<string, RefImageEntry> | undefined;
      return !!refImages?.[ref.source.slotKey]?.url;
    }

    case "audioSlot": {
      const refAudios = data.refAudios as unknown[] | undefined;
      return Array.isArray(refAudios) && ref.source.index >= 0 && ref.source.index < refAudios.length;
    }

    case "videoSlot": {
      const refVideos = data.refVideos as unknown[] | undefined;
      return Array.isArray(refVideos) && ref.source.index >= 0 && ref.source.index < refVideos.length;
    }

    default:
      return false;
  }
}

function pruneInlineReferences(
  data: Record<string, unknown>,
  targetCardId: string,
  validConnectionKeys: Set<string>,
): boolean {
  const refs = Array.isArray(data.inlineRefs) ? (data.inlineRefs as InlineImageRef[]) : [];
  if (refs.length === 0) return false;

  const validRefs = refs.filter((ref) => isInlineRefStillValid(ref, data, targetCardId, validConnectionKeys));
  const validIds = new Set(validRefs.map((ref) => ref.id));

  let changed = validRefs.length !== refs.length;

  if (typeof data.content === "string") {
    const nextContent = data.content.replace(/\{\{ref:([^}]+)\}\}\s?/g, (match, id: string) => {
      if (validIds.has(id)) return match;
      changed = true;
      return "";
    });
    if (nextContent !== data.content) {
      data.content = nextContent;
    }
  }

  if (changed) {
    data.inlineRefs = validRefs.length > 0 ? validRefs : undefined;
  }

  return changed;
}

export function cleanupDanglingReferencesForCard(
  card: CanvasCard,
  validConnectionKeys: Set<string>,
): CleanupResult {
  const originalData = card.data as Record<string, unknown>;
  const data = { ...originalData };
  let changed = false;

  if (isPlainObject(data.refImages)) {
    const refImages = { ...(data.refImages as Record<string, RefImageEntry>) };
    const removedKeys: string[] = [];

    for (const [slotKey, entry] of Object.entries(refImages)) {
      if (entry?.sourceCardId && !hasValidConnection(validConnectionKeys, entry.sourceCardId, card.id)) {
        delete refImages[slotKey];
        removedKeys.push(slotKey);
      }
    }

    if (removedKeys.length > 0) {
      data.refImages = Object.keys(refImages).length > 0 ? refImages : undefined;
      for (const key of removedKeys) {
        if (key === "person") data.personImageUrl = undefined;
        if (key === "garment") data.garmentImageUrl = undefined;
      }
      changed = true;
    }
  }

  if (isPlainObject(data.upstreamTexts)) {
    const upstreamTexts = { ...(data.upstreamTexts as Record<string, string>) };
    let removed = false;

    for (const sourceCardId of Object.keys(upstreamTexts)) {
      if (!hasValidConnection(validConnectionKeys, sourceCardId, card.id)) {
        delete upstreamTexts[sourceCardId];
        removed = true;
      }
    }

    if (removed) {
      data.upstreamTexts = Object.keys(upstreamTexts).length > 0 ? upstreamTexts : undefined;
      changed = true;
    }
  }

  if (typeof data.upstreamCardId === "string" && !hasValidConnection(validConnectionKeys, data.upstreamCardId, card.id)) {
    data.upstreamCardId = undefined;
    data.upstreamText = undefined;
    data.upstreamImageUrl = undefined;
    changed = true;
  }

  if (Array.isArray(data.refFrames)) {
    const frames = data.refFrames as VideoFrameRef[];
    const filtered = frames.filter(
      (frame) => !frame.sourceCardId || hasValidConnection(validConnectionKeys, frame.sourceCardId, card.id),
    );
    if (filtered.length !== frames.length) {
      data.refFrames = filtered.length > 0 ? filtered : undefined;
      changed = true;
    }
  }

  if (Array.isArray(data.refAudios)) {
    const audios = data.refAudios as SourceRef[];
    const filtered = audios.filter(
      (audio) => !audio.sourceCardId || hasValidConnection(validConnectionKeys, audio.sourceCardId, card.id),
    );
    if (filtered.length !== audios.length) {
      data.refAudios = filtered.length > 0 ? filtered : undefined;
      changed = true;
    }
  }

  if (Array.isArray(data.refVideos)) {
    const videos = data.refVideos as SourceRef[];
    const filtered = videos.filter(
      (video) => !video.sourceCardId || hasValidConnection(validConnectionKeys, video.sourceCardId, card.id),
    );
    if (filtered.length !== videos.length) {
      data.refVideos = filtered.length > 0 ? filtered : undefined;
      changed = true;
    }
  }

  if (Array.isArray(data.directMedia)) {
    const media = data.directMedia as MediaEntry[];
    const filtered = media.filter(
      (item) => !item.sourceCardId || hasValidConnection(validConnectionKeys, item.sourceCardId, card.id),
    );
    if (filtered.length !== media.length) {
      data.directMedia = filtered.length > 0 ? filtered : undefined;
      changed = true;
    }
  }

  if (pruneInlineReferences(data, card.id, validConnectionKeys)) {
    changed = true;
  }

  if (!changed) {
    return { data: originalData, changed: false };
  }

  return { data: withoutUndefinedFields(data), changed: true };
}

export function cleanupDanglingReferencesInCards(
  cards: CanvasCard[],
  connections: Connection[],
): { cards: CanvasCard[]; changedCardIds: string[] } {
  const cardIds = new Set(cards.map((card) => card.id));
  const validConnectionKeys = buildValidConnectionKeys(connections, cardIds);
  const changedCardIds: string[] = [];

  const cleanedCards = cards.map((card) => {
    const result = cleanupDanglingReferencesForCard(card, validConnectionKeys);
    if (!result.changed) return card;
    changedCardIds.push(card.id);
    return { ...card, data: result.data };
  });

  return { cards: cleanedCards, changedCardIds };
}

export function cleanupDanglingReferencesInStore(
  options: { markDirty?: boolean; cardIds?: Iterable<string> } = {},
): CleanupSummary {
  const cardStore = useCardStore.getState();
  const allCards = cardStore.cards;
  const validConnectionKeys = buildValidConnectionKeys(
    useConnectionStore.getState().connections.values(),
    new Set(allCards.keys()),
  );
  const idsToCheck = options.cardIds ? Array.from(options.cardIds) : Array.from(allCards.keys());
  const changedCardIds: string[] = [];

  for (const cardId of idsToCheck) {
    const latestCard = useCardStore.getState().getCard(cardId);
    if (!latestCard) continue;

    const result = cleanupDanglingReferencesForCard(latestCard, validConnectionKeys);
    if (!result.changed) continue;

    // Merge cleanup result into the LATEST card data so concurrent writes
    // (e.g. an editor's pending updateCardData call) cannot revive removed refs.
    useCardStore.getState().updateCardData(cardId, diffDataPatch(latestCard.data as Record<string, unknown>, result.data));
    changedCardIds.push(cardId);
    if (options.markDirty !== false) {
      autoSave.markDirty(cardId);
    }
  }

  return { changedCardIds };
}

export function cleanupReferencesForDisconnectedPair(
  targetCardId: string,
  sourceCardId: string,
  options: { markDirty?: boolean } = {},
): CleanupSummary {
  const cardStore = useCardStore.getState();
  const target = cardStore.getCard(targetCardId);
  if (!target) return { changedCardIds: [] };

  const validConnectionKeys = buildValidConnectionKeys(
    useConnectionStore.getState().connections.values(),
    new Set(cardStore.cards.keys()),
  );

  if (hasValidConnection(validConnectionKeys, sourceCardId, targetCardId)) {
    return { changedCardIds: [] };
  }

  const result = cleanupDanglingReferencesForCard(target, validConnectionKeys);
  if (!result.changed) return { changedCardIds: [] };

  cardStore.updateCardData(targetCardId, diffDataPatch(target.data as Record<string, unknown>, result.data));
  if (options.markDirty !== false) {
    autoSave.markDirty(targetCardId);
  }
  return { changedCardIds: [targetCardId] };
}

/**
 * Compute a minimal patch that, when applied via `updateCardData`, transforms
 * `prev` → `next`. Removed keys are encoded as `undefined`. This lets the
 * cleanup write narrowly and survive concurrent editor writes.
 */
function diffDataPatch(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(prev)) {
    if (!(key in next)) patch[key] = undefined;
  }
  for (const [key, value] of Object.entries(next)) {
    if (prev[key] !== value) patch[key] = value;
  }
  return patch;
}

export function disconnectConnectionAndCleanup(
  connectionId: string,
  options: { markDirty?: boolean } = {},
): boolean {
  const connStore = useConnectionStore.getState();
  const conn = connStore.connections.get(connectionId);
  if (!conn) return false;

  connStore.removeConnection(connectionId);
  cleanupReferencesForDisconnectedPair(conn.targetCardId, conn.sourceCardId, options);

  if (options.markDirty !== false) {
    autoSave.markDirty();
  }
  return true;
}

export function disconnectConnectionsForCardAndCleanup(
  cardId: string,
  options: { markDirty?: boolean } = {},
): number {
  const connStore = useConnectionStore.getState();
  const affectedTargets = new Set<string>();
  let removed = 0;

  for (const conn of connStore.connections.values()) {
    if (conn.sourceCardId === cardId) affectedTargets.add(conn.targetCardId);
    if (conn.sourceCardId === cardId || conn.targetCardId === cardId) removed++;
  }

  if (removed === 0) return 0;

  connStore.removeConnectionsForCard(cardId);
  cleanupDanglingReferencesInStore({ markDirty: options.markDirty, cardIds: affectedTargets });

  if (options.markDirty !== false) {
    autoSave.markDirty();
  }
  return removed;
}

export function findConnectionId(sourceCardId: string, targetCardId: string): string | null {
  for (const [id, conn] of useConnectionStore.getState().connections) {
    if (conn.sourceCardId === sourceCardId && conn.targetCardId === targetCardId) {
      return id;
    }
  }
  return null;
}

export function disconnectCardPairAndCleanup(
  sourceCardId: string,
  targetCardId: string,
  options: { markDirty?: boolean } = {},
): boolean {
  const connectionId = findConnectionId(sourceCardId, targetCardId);
  if (!connectionId) {
    cleanupReferencesForDisconnectedPair(targetCardId, sourceCardId, options);
    return false;
  }
  return disconnectConnectionAndCleanup(connectionId, options);
}

export function removeConnectionsForCardIdsAndCleanup(
  cardIds: Iterable<string>,
  options: { markDirty?: boolean } = {},
): number {
  const ids = new Set(cardIds);
  if (ids.size === 0) return 0;

  const connStore = useConnectionStore.getState();
  const affectedTargets = new Set<string>();
  const removeIds: string[] = [];

  for (const conn of connStore.connections.values()) {
    const removesSource = ids.has(conn.sourceCardId);
    const removesTarget = ids.has(conn.targetCardId);
    if (removesSource || removesTarget) {
      removeIds.push(conn.id);
      if (removesSource && !removesTarget) affectedTargets.add(conn.targetCardId);
    }
  }

  if (removeIds.length === 0) return 0;

  for (const id of removeIds) {
    connStore.removeConnection(id);
  }
  cleanupDanglingReferencesInStore({ markDirty: options.markDirty, cardIds: affectedTargets });

  if (options.markDirty !== false) {
    autoSave.markDirty();
  }
  return removeIds.length;
}

export function getInlineUpstreamSourceIds(data: Record<string, unknown>): string[] {
  if (!Array.isArray(data.inlineRefs)) return [];
  const ids = new Set<string>();
  for (const ref of data.inlineRefs as InlineImageRef[]) {
    const sourceCardId = getSourceCardIdFromInlineRef(ref);
    if (sourceCardId) ids.add(sourceCardId);
  }
  return Array.from(ids);
}

// ─── Lifecycle integration ──────────────────────────────────────────────────
//
// Reference cleanup must run as a SYNCHRONOUS side effect of every connection
// mutation, regardless of which component triggered it. Doing it via Zustand
// `subscribe` (the previous design) opens a race: an editor that calls
// `removeConnection(id)` and then `updateCard(id, { data: { ...staleData, ...patch } })`
// would silently overwrite the cleanup with stale closure data, leaving
// orphaned refImages / upstreamTexts / refFrames / refAudios / refVideos /
// directMedia / inlineRefs visible in the editor. Hooks fire AFTER the store
// state is committed but BEFORE any consumer can react, so the cleanup wins.
//
// The hooks are registered exactly once at module load.

setConnectionLifecycleHooks({
  onConnectionsRemoved: (removed) => {
    const affectedTargets = new Set<string>();
    for (const conn of removed) affectedTargets.add(conn.targetCardId);
    if (affectedTargets.size === 0) return;
    cleanupDanglingReferencesInStore({ cardIds: affectedTargets });
  },
  onConnectionsAdded: (added) => {
    if (added.length === 0) return;
    // 1. 把上游已有输出写入下游对应字段（参考图、上游文字等），
    //    这样所有调用方（手动连线 / 模板创建 / 粘贴 / WireDrop / ImageToolbar）
    //    无需手动调 injectOnConnect，连线生命周期保证一致。
    injectOnConnections(added);
    // 2. 兜底：审计目标卡片，移除任何不再有效连接的残留引用，
    //    防止旧的脏数据搭新连线"复活"。
    const affectedTargets = new Set<string>();
    for (const conn of added) affectedTargets.add(conn.targetCardId);
    cleanupDanglingReferencesInStore({ cardIds: affectedTargets });
  },
});
