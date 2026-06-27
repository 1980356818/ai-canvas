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
import { recordBatchCreate, recordMove, recordGroupCreate, history } from "@/lib/history";
import { injectOnConnect } from "@/lib/dataFlow";
import { groupToRow } from "@/lib/mappers";
import { DEFAULT_GROUP_COLOR, GROUP_PADDING } from "@/types/group";
import { computeEnvelopeBounds } from "@/lib/groupBounds";
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

/**
 * 「按组复制」副本相对源框的水平让位间隙(world px)。
 * 当粘贴落点会让副本外接框压在源外接框上时,把副本整体推到源右侧、与源框留出这个间隙,
 * 避免两个 Frame 几乎同位(同位虽不再丢成员——见 frameMembership 的成员粘性——但用户
 * 难以分辨、拖框体验割裂)。取 4×GROUP_PADDING 以保证两框边界之间留出 >2×padding 的可视空隙。
 */
const PASTE_GROUP_CLEAR_GAP = GROUP_PADDING * 4;

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

/**
 * 连线收集模式 —— 决定哪些「与选区相连」的连线被纳入 payload。
 * 跨界连线(一端在选区外)的另一端在 materialize 时按原 id 重连,且仅当该邻居仍在目标项目内。
 *  - "internal":仅两端都在选区内的连线(自洽子图)。
 *  - "incoming"(复制用):内部连线 + 指向选区内卡片的「上游输入」连线;出方向不带,
 *    避免下游邻居被副本多喂一路输入(产品决策:复制只继承上游输入)。
 *  - "all"(移动用):一切与选区相连的连线(内部 + 上游输入 + 下游输出),
 *    使整卡搬移时接线完全跟随。
 */
export type ConnectionCollectMode = "internal" | "incoming" | "all";

export function collectSelected(
  cardIds: Set<string>,
  opts: { connectionMode?: ConnectionCollectMode } = {},
): {
  cards: CanvasCard[];
  connections: Connection[];
  groups: ClipboardGroup[];
} {
  const connectionMode = opts.connectionMode ?? "internal";
  const cardStore = useCardStore.getState();
  const cards: CanvasCard[] = [];
  for (const id of cardIds) {
    const c = cardStore.getCard(id);
    if (c) cards.push(c);
  }

  const connections: Connection[] = [];
  for (const conn of useConnectionStore.getState().connections.values()) {
    const srcIn = cardIds.has(conn.sourceCardId);
    const tgtIn = cardIds.has(conn.targetCardId);
    let keep: boolean;
    switch (connectionMode) {
      case "all":
        keep = srcIn || tgtIn;
        break;
      case "incoming":
        keep = tgtIn;
        break;
      default:
        keep = srcIn && tgtIn;
        break;
    }
    if (keep) connections.push(conn);
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
  // 复制语义:副本继承上游输入连线(incoming);出方向连线不带。
  const { cards, connections, groups } = collectSelected(cardIds, {
    connectionMode: "incoming",
  });
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
    // 移动:保留卡片的全部连线(上游输入 + 下游输出 + 内部),使接线完全跟随。
    const live = collectSelected(cutIds, { connectionMode: "all" });
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
      // 原卡删除后,其占用的下游邻居槽位才释放;此刻对新卡的下游再注入一次,补回
      // 「原卡占槽 → materialize 注入落空」错过的引用。injectOnConnect 命中即 no-op,幂等安全。
      reinjectDownstream(newCardIds);
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
 * 对一批新卡的所有「出方向」连线重新注入上游输出(幂等)。
 * 移动落地后调用:原卡删除会释放它曾占用的下游邻居槽位,而 materialize 阶段那次注入
 * 可能因槽位仍被原卡占用而落空 —— 这里补一次,把新卡输出写进刚释放的槽位。
 * injectOnConnect 内部「值相同则不写」,对已注入成功的连线不会重复改动。
 */
function reinjectDownstream(newCardIds: string[]) {
  if (newCardIds.length === 0) return;
  const ids = new Set(newCardIds);
  for (const conn of useConnectionStore.getState().connections.values()) {
    if (ids.has(conn.sourceCardId)) {
      injectOnConnect(conn.sourceCardId, conn.targetCardId);
    }
  }
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

  // ── 落点偏移 ────────────────────────────────────────────────────────────────
  // 源卡外接框(居中落点 + 组副本避让都要用),先算一次。
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of srcCards) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + c.width);
    maxY = Math.max(maxY, c.y + c.height);
  }
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;

  // 基准偏移:有落点 → 外接框中心对齐落点;否则固定 +30。
  let offsetX = 30;
  let offsetY = 30;
  if (position) {
    offsetX = position.worldX - (minX + maxX) / 2;
    offsetY = position.worldY - (minY + maxY) / 2;
  }

  // 「按组复制」避让:副本带组时,若基准偏移会让副本外接框与源外接框相交
  //(两个等尺寸框相距 < 各自宽且 < 各自高时相交),把副本整体推到源右侧并留出间隙。
  // 于是组副本默认落在源框旁边而非压在源框上 —— 与 frameMembership 的成员粘性互补:
  // 粘性保证「即便重叠也不丢成员」,这里保证「默认就不重叠」。
  const hasGroups = (payload.groups?.length ?? 0) > 0;
  if (hasGroups && Math.abs(offsetX) < bboxW && Math.abs(offsetY) < bboxH) {
    offsetX = bboxW + PASTE_GROUP_CLEAR_GAP;
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

  // Recreate connections with remapped IDs.
  // 每端独立解析:被复制的一端映射到新卡;选区外的另一端按原 id 重连,但仅当该邻居仍在
  // 目标项目内(跨项目粘贴 / 邻居已删 → 跳过该端)。由此一套逻辑同时覆盖:
  //   · 内部连线(两端都被复制,如多选复制 / 移动)
  //   · 上游输入连线(仅目标被复制,复制 "incoming" 与移动 "all" 都会产生)
  //   · 下游输出连线(仅源被复制,仅移动 "all" 会产生)
  // 连线建立后 onConnectionsAdded 生命周期会把上游当前输出注入下游对应槽位,无需手动搬运引用。
  const resolveEnd = (
    mapped: string | undefined,
    originalId: string,
  ): string | undefined => {
    if (mapped) return mapped;
    const neighbor = useCardStore.getState().getCard(originalId);
    return neighbor && neighbor.projectId === projectId ? originalId : undefined;
  };
  for (const src of srcConns) {
    const mappedSource = idMap.get(src.sourceCardId);
    const mappedTarget = idMap.get(src.targetCardId);
    // 防御:至少一端必须是被复制的卡(collectSelected 已保证),否则不是本次该重建的连线。
    if (!mappedSource && !mappedTarget) continue;

    const sourceCardId = resolveEnd(mappedSource, src.sourceCardId);
    const targetCardId = resolveEnd(mappedTarget, src.targetCardId);
    if (!sourceCardId || !targetCardId) continue;

    const conn: Connection = {
      id: crypto.randomUUID(),
      projectId,
      sourceCardId,
      targetCardId,
      createdAt: now,
    };
    useConnectionStore.getState().addConnection(conn);
  }

  // Recreate groups with remapped IDs(只重建 selection 完整包住的组,parseClipboard 已保证)
  const srcGroups = payload.groups ?? [];
  const newGroupIds: string[] = [];
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
        // Frame 边界 = 粘贴后卡片外接框(cards 已先于 group 加入 store)
        ...(computeEnvelopeBounds({ cardIds: mapped }) ?? { x: 0, y: 0, width: 0, height: 0 }),
        createdAt: now,
        updatedAt: now,
      };
      groupStore.addGroup(newGroup);
      newGroupIds.push(newGroup.id);
    }
    const all = groupStore.getGroupsByProject(projectId);
    void saveGroupsBatch(all.map(groupToRow)).catch((e) =>
      console.warn("[clipboard.materialize] saveGroupsBatch failed:", e),
    );
  }

  syncNodeCount(projectId);
  useCanvasStore.getState().setSelectedCardIds(newCardIds);
  // 复制粘贴:卡片创建 + 组创建合成**一次**原子撤销 —— 一次 Ctrl+Z 退掉整组(卡 + 框),
  // 不再「卡没了框还在」。移动路径(recordHistory=false)由调用方用 recordMove 合成单步撤销。
  if (recordHistory) {
    history.transact(() => {
      recordBatchCreate(newCardIds);
      for (const gid of newGroupIds) recordGroupCreate(gid);
    });
  }

  // Defense-in-depth: refs are already stripped at copy time by collectSelected(),
  // but external clipboard payloads or older formats may still carry stale refs.
  cleanupDanglingReferencesInStore({ cardIds: newCardIds });

  return newCardIds;
}
