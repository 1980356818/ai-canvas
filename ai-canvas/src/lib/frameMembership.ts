/**
 * Frame 成员校准权威 —— 唯一的「谁属于哪个框」写入口。
 *
 * Frame 容器化后,组(Frame)拥有自己存储的边界矩形,**成员 = 中心点落在框内的卡片**
 * (空间即真相)。`group.cardIds` 降级为「派生缓存」:不再由用户手动增删,而是由本模块
 * 在每次几何提交(打开项目 / 移卡 / 移框 / 缩放框 / 建删卡)后从边界重算并落库。
 *
 * 规则:
 *   - 命中判定:卡片中心点 ∈ 框 rect(与 hitGroupAt 同源)。
 *   - 单成员:一卡只属一框;重叠时**最上层框赢**(沿 getGroupsByProject 渲染顺序,后者覆盖前者)。
 *   - 折叠冻结:折叠框的成员保持不变,且其成员不参与其它框的空间吸收
 *     (折叠后 rect 缩成胶囊,无法再靠空间判定,必须冻结)。
 *
 * 性能:O(框数 × 卡数),只在「提交时」跑一次(非每帧),典型画布完全可接受。
 * 详见 docs/Frame容器化-架构与施工图.md。
 */

import { useCardStore } from "@/stores/cardStore";
import { useGroupStore } from "@/stores/groupStore";
import { computeGroupBounds, type GroupBounds } from "@/lib/groupBounds";
import { groupToRow } from "@/lib/mappers";
import { saveGroupsBatch } from "@/platform";
import type { CanvasCard } from "@/types";

/** 卡片中心点是否落在 rect 内(闭区间)。 */
function centerInRect(card: CanvasCard, rect: GroupBounds): boolean {
  const cx = card.x + card.width / 2;
  const cy = card.y + card.height / 2;
  return (
    cx >= rect.x &&
    cx <= rect.x + rect.width &&
    cy >= rect.y &&
    cy <= rect.y + rect.height
  );
}

/** 返回中心点落在 rect 内的卡片 id(纯函数,不读全局)。 */
export function cardsInFrame(
  rect: GroupBounds,
  cards: Map<string, CanvasCard>,
): string[] {
  const out: string[] = [];
  for (const [cid, c] of cards) {
    if (centerInRect(c, rect)) out.push(cid);
  }
  return out;
}

/**
 * 按存储边界重算某项目所有展开框的成员,写回 store + 落库(仅在有变化时)。
 * 返回是否发生了成员变化。
 */
export function reconcileFrameMembership(projectId: string): boolean {
  const groupStore = useGroupStore.getState();
  const groups = groupStore.getGroupsByProject(projectId); // 渲染顺序
  if (groups.length === 0) return false;

  const cards = useCardStore.getState().cards;

  // 折叠框成员冻结:保持原样,且这些卡不参与任何框的空间吸收。
  const frozen = new Set<string>();
  for (const g of groups) {
    if (g.collapsed) for (const cid of g.cardIds) frozen.add(cid);
  }

  // 每张卡 → 命中的最上层展开框(渲染顺序后者覆盖前者 → 最上层赢)。
  const owner = new Map<string, string>();
  for (const g of groups) {
    if (g.collapsed) continue;
    const rect = computeGroupBounds(g, cards);
    if (!rect) continue;
    for (const cid of cardsInFrame(rect, cards)) {
      if (frozen.has(cid)) continue;
      owner.set(cid, g.id);
    }
  }

  // 为每个展开框组装新成员:保持已有顺序在前、新增追加(减少 cardIds 顺序 churn)。
  let changed = false;
  for (const g of groups) {
    if (g.collapsed) continue;
    const desired = new Set<string>();
    for (const [cid, gid] of owner) if (gid === g.id) desired.add(cid);

    const next: string[] = [];
    for (const cid of g.cardIds) {
      if (desired.has(cid)) {
        next.push(cid);
        desired.delete(cid);
      }
    }
    for (const cid of desired) next.push(cid);

    const sameAsBefore =
      next.length === g.cardIds.length &&
      next.every((cid, i) => cid === g.cardIds[i]);
    if (!sameAsBefore) {
      // updateGroup 内部 maintainSingleMembership 会把这些卡从其它框挤出 —— 与本处
      // 已算出的「单一归属」一致,无冲突。空框不删除(Frame 模型允许空容器存在)。
      groupStore.updateGroup(g.id, { cardIds: next });
      changed = true;
    }
  }

  if (changed) {
    // 全量落库本项目的组:reconcile 可能经 maintainSingleMembership 顺带改了其它框,
    // 组数量小,整批保存最稳妥(与 groupActions 一致)。
    const all = groupStore.getGroupsByProject(projectId);
    void saveGroupsBatch(all.map(groupToRow)).catch((e) =>
      console.warn("[frameMembership] reconcile persist failed:", e),
    );
  }
  return changed;
}
