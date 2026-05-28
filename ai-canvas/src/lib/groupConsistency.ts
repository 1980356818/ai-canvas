/**
 * 节点分组(card_groups)与卡片之间的一致性维护。
 *
 * ─── 不变式 ────────────────────────────────────────────────────
 *  • 组中的 cardId 必须对应一个真实存在的 card;
 *  • 组的 cardIds 数组中元素去重;
 *  • cardIds 为空的组不应继续存在(自动删除);
 *  • 一卡只能属于一组(由 groupStore.maintainSingleMembership 强制)。
 *
 * ─── 调用时机 ──────────────────────────────────────────────────
 *  • 卡片**被删**时 — 由 deleteSelected / ContextMenu 删卡入口调
 *    `pruneGroupsForRemovedCards(removedCardIds)`,移除对应 cardId,
 *    空组连带删除;
 *  • 项目加载时 — 由 `loadAndSanitizeGroups(projectId)` 包装,过滤掉
 *    指向不存在卡片的 id 并去重,把脏数据修正后回写。
 *
 * ─── 为什么不走 lifecycle hooks ─────────────────────────────────
 * cardStore 当前没有 lifecycle hooks 系统(只有 connectionStore 有)。
 * 加 cardStore hook 是大手术,会触及 cardStore 的"双版本号"语义;本期
 * 节制改动,直接在两个删卡入口显式调本模块的函数即可,保持低侵入。
 */

import { useGroupStore } from "@/stores/groupStore";
import { useCardStore } from "@/stores/cardStore";
import { deleteGroup, saveGroupsBatch } from "@/platform";
import { groupToRow } from "@/lib/mappers";
import { autoSave } from "@/lib/autoSave";

export interface PruneSummary {
  updatedGroupIds: string[];
  deletedGroupIds: string[];
}

/**
 * 卡片删除后:同步从所有组里移除对应 cardId;空组自动删。
 * 同时落库(updated → save_batch,deleted → delete_group)。
 *
 * 调用方不需要 await(持久化路径会通过 autoSave 兜底),但本函数仍 fire-and-forget
 * 自己跑一次 saveGroupsBatch / deleteGroup,避免组数据在崩溃时丢失。
 */
export function pruneGroupsForRemovedCards(cardIds: Iterable<string>): PruneSummary {
  const { updatedGroupIds, deletedGroupIds } =
    useGroupStore.getState().removeCardsFromGroups(cardIds);

  if (updatedGroupIds.length === 0 && deletedGroupIds.length === 0) {
    return { updatedGroupIds, deletedGroupIds };
  }

  // 持久化:被删的组走 deleteGroup,被改的组走 saveGroupsBatch。
  // 失败不抛 —— 调用方一般在异步 await deleteCard,持久化失败会被 autoSave
  // 在下一次 flush 中补救;这里只在 console 留痕。
  for (const gid of deletedGroupIds) {
    void deleteGroup(gid).catch((e) =>
      console.warn(`[groupConsistency] deleteGroup(${gid}) failed:`, e),
    );
  }

  if (updatedGroupIds.length > 0) {
    const rows = updatedGroupIds
      .map((gid) => useGroupStore.getState().getGroup(gid))
      .filter((g): g is NonNullable<typeof g> => g !== undefined)
      .map(groupToRow);
    if (rows.length > 0) {
      void saveGroupsBatch(rows).catch((e) =>
        console.warn("[groupConsistency] saveGroupsBatch failed:", e),
      );
    }
  }

  // markDirty 不带 id 表示"项目级别脏",触发下一次 autoSave 兜底刷一遍卡片表
  // (虽然本路径没改卡片,但保持跟"删卡"统一,避免 autoSave 静态分析漏掉)
  autoSave.markDirty();

  return { updatedGroupIds, deletedGroupIds };
}

/**
 * 项目加载后,把组里指向"不存在卡片"的 id 剔掉;空组直接删。
 *
 * 这是数据治理的兜底:防御 SQLite 端 CASCADE 没覆盖 JSON 内列、或更早的版本
 * 写过脏数据。建议在 useProjectLifecycle 切项目时,setGroups 之前调一次。
 *
 * @returns 经过 sanitize 之后实际入库的组列表(empty groups 已剔除)
 */
export function sanitizeGroupsAgainstCards(
  groups: import("@/types").CardGroup[],
): {
  sanitized: import("@/types").CardGroup[];
  changedIds: string[];
  droppedIds: string[];
} {
  const allCards = useCardStore.getState().cards;
  const changedIds: string[] = [];
  const droppedIds: string[] = [];
  const sanitized: import("@/types").CardGroup[] = [];

  // 一卡只能属一组 —— 先按"先到先得"分配,后到的组里去掉重复 cardId
  const claimed = new Set<string>();

  for (const g of groups) {
    const seen = new Set<string>();
    const keep: string[] = [];
    for (const cid of g.cardIds) {
      if (seen.has(cid)) continue;
      seen.add(cid);
      if (!allCards.has(cid)) continue;
      if (claimed.has(cid)) continue;
      claimed.add(cid);
      keep.push(cid);
    }

    if (keep.length === 0) {
      droppedIds.push(g.id);
      continue;
    }

    if (keep.length !== g.cardIds.length) {
      sanitized.push({ ...g, cardIds: keep, updatedAt: new Date().toISOString() });
      changedIds.push(g.id);
    } else {
      sanitized.push(g);
    }
  }

  return { sanitized, changedIds, droppedIds };
}
