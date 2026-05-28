/**
 * 组合 / 解组 / 重命名 等高层动作的可复用入口。
 *
 * 同一个动作有 3 个调用点 —— 快捷键、右键菜单、未来工具栏按钮。
 * 抽到这里避免重复实现,所有 UI 入口都走这一份逻辑。
 *
 * 所有函数都是同步写 store + fire-and-forget 异步落盘:
 *   • 写 groupStore(同步,立即可见);
 *   • 通过 saveGroupsBatch / deleteGroup 落 SQLite(失败 console.warn 不抛);
 *   • autoSave.markDirty 兜底,保证项目级 updatedAt 在下个 5s 周期被刷。
 */

import { useGroupStore } from "@/stores/groupStore";
import { useCardStore } from "@/stores/cardStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import type { CardGroup, CardType } from "@/types";
import { DEFAULT_GROUP_COLOR } from "@/types/group";
import { saveGroupsBatch, deleteGroup, updateProjectMeta } from "@/platform";
import { groupToRow } from "@/lib/mappers";
import { autoSave } from "@/lib/autoSave";

/** 节点类型 → 用户可读名(用于自动命名)。统计组里"多张图片节点"用。 */
const TYPE_LABEL: Record<CardType, string> = {
  ai_chat: "文本",
  ai_image: "图片",
  ai_video: "视频",
  ai_tryon: "换装",
  ai_multiangle: "多角度",
  audio: "音频",
  text: "文本",
  sticky_note: "便签",
  frame_extractor: "关键帧",
};

function autoTitleFor(cardIds: string[]): string {
  const cardStore = useCardStore.getState();
  const counts = new Map<string, number>();
  for (const cid of cardIds) {
    const c = cardStore.getCard(cid);
    if (!c) continue;
    const label = TYPE_LABEL[c.type] ?? "节点";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size === 0) return "新建组";
  // 取最多的那类作为名字,例 "3 个图片节点"
  let best: [string, number] | null = null;
  let total = 0;
  for (const [label, n] of counts) {
    total += n;
    if (!best || n > best[1]) best = [label, n];
  }
  // 全是同类 → "3 个图片节点";混合 → "5 个节点(3 图片)"
  if (best && best[1] === total) return `${total} 个${best[0]}节点`;
  return `${total} 个节点 (${best![0]} ×${best![1]})`;
}

export interface GroupCardsResult {
  groupId: string;
  /** 因"一卡一组"规则被从原组挤出的组数(已自动处理,无需调用方介入)。 */
  evictedFromGroups: number;
}

/**
 * 把传入的 cardIds 组成一个新组。约束:
 *   • cardIds.length >= 2 才有意义(单卡无需成组)。少于 2 时返回 null。
 *   • 所有卡片必须存在且属于同一 project;不一致时报 toast 并返回 null。
 *   • cardIds 中已属其它组的卡片会被自动挤出原组(groupStore 内部维护)。
 */
export function groupCards(cardIds: string[]): GroupCardsResult | null {
  const unique = Array.from(new Set(cardIds));
  if (unique.length < 2) {
    useUIStore.getState().addToast({
      type: "info",
      title: "请至少选中 2 个节点再分组",
      duration: 2500,
    });
    return null;
  }

  const cardStore = useCardStore.getState();
  const projectIds = new Set<string>();
  const validIds: string[] = [];
  for (const cid of unique) {
    const c = cardStore.getCard(cid);
    if (!c) continue;
    projectIds.add(c.projectId);
    validIds.push(cid);
  }
  if (validIds.length < 2) {
    useUIStore.getState().addToast({
      type: "error",
      title: "节点已被删除,无法分组",
      duration: 2500,
    });
    return null;
  }
  if (projectIds.size > 1) {
    useUIStore.getState().addToast({
      type: "error",
      title: "不能跨项目分组",
      duration: 2500,
    });
    return null;
  }

  const projectId = [...projectIds][0]!;

  // 计算成组后会"挤出"几个原组(仅用于反馈,不影响动作执行)
  let evicted = 0;
  const idsSet = new Set(validIds);
  for (const g of useGroupStore.getState().getGroupsByProject(projectId)) {
    let touched = false;
    for (const cid of g.cardIds) {
      if (idsSet.has(cid)) {
        touched = true;
        break;
      }
    }
    if (touched) evicted++;
  }

  const now = new Date().toISOString();
  const group: CardGroup = {
    id: crypto.randomUUID(),
    projectId,
    cardIds: validIds,
    title: autoTitleFor(validIds),
    color: DEFAULT_GROUP_COLOR,
    collapsed: false,
    createdAt: now,
    updatedAt: now,
  };

  useGroupStore.getState().addGroup(group);

  // 持久化:本组 + 所有受影响的原组(maintainSingleMembership 内可能改了它们的 cardIds)
  // 简单做法:把项目所有组都 saveGroupsBatch 一次,组数量小,不会有性能问题。
  const all = useGroupStore.getState().getGroupsByProject(projectId);
  void saveGroupsBatch(all.map(groupToRow)).catch((e) =>
    console.warn("[groupActions] groupCards persist failed:", e),
  );
  autoSave.markDirty();

  // 让用户看到反馈
  if (evicted > 0) {
    useUIStore.getState().addToast({
      type: "info",
      title: `已新建分组 (${evicted} 张卡片已从原组移出)`,
      duration: 2500,
    });
  }

  return { groupId: group.id, evictedFromGroups: evicted };
}

/**
 * 解组(销毁一个 group,卡片留在原地)。
 */
export function ungroup(groupId: string): boolean {
  const group = useGroupStore.getState().getGroup(groupId);
  if (!group) return false;
  useGroupStore.getState().removeGroup(groupId);
  void deleteGroup(groupId).catch((e) =>
    console.warn(`[groupActions] deleteGroup(${groupId}) failed:`, e),
  );

  // 同步项目 updatedAt(成组时由 saveGroupsBatch 内 upsert_group 触发,解组没走那条)
  const pid = group.projectId;
  void updateProjectMeta(pid, {}).catch(() => {});
  useProjectStore.getState().updateProject(pid, { updatedAt: new Date().toISOString() });
  return true;
}

/**
 * 从用户当前选区(useCanvasStore.selectedCardIds)解组:
 *   • 若选区里有"完整属于某组"的卡片,把它们的组解掉。
 *   • 多个组同时存在 → 全部解。
 */
export function ungroupFromSelection(): number {
  const selected = useCanvasStore.getState().selectedCardIds;
  if (selected.size === 0) return 0;
  const groupStore = useGroupStore.getState();
  const groupsToRemove = new Set<string>();
  for (const cid of selected) {
    const g = groupStore.getGroupByCardId(cid);
    if (g) groupsToRemove.add(g.id);
  }
  let removed = 0;
  for (const gid of groupsToRemove) {
    if (ungroup(gid)) removed++;
  }
  return removed;
}

/**
 * 从用户当前选区组成新组。语法糖。
 */
export function groupFromSelection(): GroupCardsResult | null {
  const selected = useCanvasStore.getState().selectedCardIds;
  return groupCards([...selected]);
}

/**
 * 重命名组。
 */
export function renameGroup(groupId: string, title: string): boolean {
  const group = useGroupStore.getState().getGroup(groupId);
  if (!group) return false;
  useGroupStore.getState().updateGroup(groupId, { title });
  autoSave.markGroupDirty(groupId);
  return true;
}

/**
 * 改组颜色(M3 阶段从右键菜单调用)。
 */
export function setGroupColor(groupId: string, color: string): boolean {
  const group = useGroupStore.getState().getGroup(groupId);
  if (!group) return false;
  useGroupStore.getState().updateGroup(groupId, { color });
  autoSave.markGroupDirty(groupId);
  return true;
}

/**
 * 折叠/展开组(M3 阶段使用)。
 */
export function toggleGroupCollapsed(groupId: string): boolean {
  const group = useGroupStore.getState().getGroup(groupId);
  if (!group) return false;
  useGroupStore.getState().updateGroup(groupId, { collapsed: !group.collapsed });
  autoSave.markGroupDirty(groupId);
  return true;
}
