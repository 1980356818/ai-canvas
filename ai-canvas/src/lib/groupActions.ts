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
import type { CardGroup, CardType, CanvasCard } from "@/types";
import { DEFAULT_GROUP_COLOR } from "@/types/group";
import { saveGroupsBatch, deleteGroup, updateProjectMeta } from "@/platform";
import { groupToRow } from "@/lib/mappers";
import { autoSave } from "@/lib/autoSave";
import { recordUpdate } from "@/lib/history";

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
  const idsSet = new Set(validIds);
  const projectGroups = useGroupStore.getState().getGroupsByProject(projectId);

  // ── 规范化语义 — 在新建之前判断当前 selection 与现有组的关系 ──
  //
  // 1) selection == 某组的完整成员集 → noop。
  //    用户对一个已有组按 Ctrl+G 不应该把它的 id/color/title 全部丢掉重建。
  // 2) selection ⊂ 某组 (>=2) → 从该组拆出 selection 成新组,原组保留剩余。
  //    这是"从大组里拆小组"的明确预期行为。
  // 3) selection 跨越多个组 → 走现有合并语义(挤出 + 新建),toast 说明。
  // 4) selection 不与任何组重叠 → 普通新建。
  //
  // 这一段不写入 store,只决定走哪条路径。
  const touchedGroups: typeof projectGroups = [];
  let supersetGroup: (typeof projectGroups)[number] | null = null;
  for (const g of projectGroups) {
    let intersect = false;
    let containsAll = true;
    const gSet = new Set(g.cardIds);
    for (const cid of validIds) {
      if (gSet.has(cid)) intersect = true;
      else containsAll = false;
    }
    if (intersect) touchedGroups.push(g);
    if (containsAll) supersetGroup = g;
  }

  // 分支 1: selection == 某组的完整成员
  const equalsGroup = touchedGroups.find(
    (g) =>
      g.cardIds.length === validIds.length &&
      g.cardIds.every((cid) => idsSet.has(cid)),
  );
  if (equalsGroup) {
    useUIStore.getState().addToast({
      type: "info",
      title: `这些节点已在组 "${equalsGroup.title}" 中`,
      duration: 2500,
    });
    return { groupId: equalsGroup.id, evictedFromGroups: 0 };
  }

  // 分支 2: selection 完全属于某一个组(supersetGroup)的真子集 → 拆出新组,原组保留剩余
  // 注意:超组的 cardIds.length 必须 > validIds.length 才算"拆"
  if (supersetGroup && supersetGroup.cardIds.length > validIds.length && touchedGroups.length === 1) {
    const remaining = supersetGroup.cardIds.filter((cid) => !idsSet.has(cid));
    // 注意 maintainSingleMembership 会自动把 validIds 从 supersetGroup 里挤出来,这里不需要手动改
    // 但我们要保证原组在剩余 >=1 卡时仍存活;空原组会被 store 自动删,这恰好覆盖了"拆完原组只剩 0 张"
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
    const all = useGroupStore.getState().getGroupsByProject(projectId);
    void saveGroupsBatch(all.map(groupToRow)).catch((e) =>
      console.warn("[groupActions] groupCards split persist failed:", e),
    );
    autoSave.markDirty();
    useUIStore.getState().addToast({
      type: "info",
      title: `已从 "${supersetGroup.title}" 拆出新组 (原组保留 ${remaining.length} 个节点)`,
      duration: 2500,
    });
    return { groupId: group.id, evictedFromGroups: 1 };
  }

  // 分支 3/4: 跨多组合并 或 普通新建
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

  const evicted = touchedGroups.length;
  if (evicted > 0) {
    useUIStore.getState().addToast({
      type: "info",
      title: `已新建分组 (来自 ${evicted} 个原组的节点已合并)`,
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
 * 把若干卡片加入指定组(用于拖卡入组、Agent 工具)。
 *   - 已属该组的卡跳过(不算"加入"也不算"挤出");
 *   - 属于其它组的卡由 groupStore.maintainSingleMembership 自动挤出原组;
 *   - 跨项目的卡拒绝(不做静默忽略,toast 警告)。
 *
 * 落盘策略与 groupCards 一致:批量 save 项目所有组。
 *
 * @returns 实际新加入此组的卡片数;<=0 表示未变动
 */
export function addCardsToGroup(groupId: string, cardIds: string[]): number {
  const group = useGroupStore.getState().getGroup(groupId);
  if (!group) return 0;
  const cardStore = useCardStore.getState();

  const fresh: string[] = [];
  const existingSet = new Set(group.cardIds);
  for (const cid of cardIds) {
    if (existingSet.has(cid)) continue;
    const c = cardStore.getCard(cid);
    if (!c) continue;
    if (c.projectId !== group.projectId) {
      useUIStore.getState().addToast({
        type: "warning",
        title: "跨项目无法加入组",
        duration: 2000,
      });
      continue;
    }
    fresh.push(cid);
  }
  if (fresh.length === 0) return 0;

  const nextIds = [...group.cardIds, ...fresh];
  useGroupStore.getState().updateGroup(groupId, { cardIds: nextIds });

  // 持久化:本组 + 受影响的原组(被挤出的卡所在组)。
  const all = useGroupStore.getState().getGroupsByProject(group.projectId);
  void saveGroupsBatch(all.map(groupToRow)).catch((e) =>
    console.warn("[groupActions] addCardsToGroup persist failed:", e),
  );
  autoSave.markDirty();
  return fresh.length;
}

/**
 * F12: 组内卡片排版。
 *
 * 三种模式:
 *   - horizontal: 等间距横向铺 (按当前 y 中位数对齐,从最左 x 开始)
 *   - vertical:   等间距纵向铺 (按当前 x 中位数对齐,从最上 y 开始)
 *   - grid:       ceil(sqrt(n)) × ceil(n/cols) 的网格,锚点 = 组左上
 *
 * 顺序:稳定按 zIndex 升序;同 zIndex 按 createdAt。所有几何变更走 recordUpdate
 * + autoSave,与拖拽提交完全等价(可 undo)。
 */
export type GroupLayoutMode = "horizontal" | "vertical" | "grid";

/** 排版时的卡片间隙(world 单位)。 */
const LAYOUT_GAP = 24;

export function layoutGroup(groupId: string, mode: GroupLayoutMode): boolean {
  const group = useGroupStore.getState().getGroup(groupId);
  if (!group) return false;
  const cardStore = useCardStore.getState();

  const members: CanvasCard[] = [];
  for (const cid of group.cardIds) {
    const c = cardStore.getCard(cid);
    if (c) members.push(c);
  }
  if (members.length < 2) {
    useUIStore.getState().addToast({
      type: "info",
      title: "至少 2 个节点才能排版",
      duration: 2000,
    });
    return false;
  }

  // 稳定顺序: zIndex 升序;tie → createdAt 升序
  members.sort((a, b) => {
    if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex;
    return a.createdAt.localeCompare(b.createdAt);
  });

  // 锚点: 组左上(用当前 bounds 的左上,不含 padding/title)
  const anchorX = Math.min(...members.map((c) => c.x));
  const anchorY = Math.min(...members.map((c) => c.y));

  const targets: { card: CanvasCard; x: number; y: number }[] = [];

  if (mode === "horizontal") {
    let cx = anchorX;
    const cy = anchorY;
    const maxH = Math.max(...members.map((c) => c.height));
    for (const c of members) {
      // 按 maxH 中心对齐,视觉更整齐
      const y = cy + (maxH - c.height) / 2;
      targets.push({ card: c, x: cx, y });
      cx += c.width + LAYOUT_GAP;
    }
  } else if (mode === "vertical") {
    let cy = anchorY;
    const cx = anchorX;
    const maxW = Math.max(...members.map((c) => c.width));
    for (const c of members) {
      const x = cx + (maxW - c.width) / 2;
      targets.push({ card: c, x, y: cy });
      cy += c.height + LAYOUT_GAP;
    }
  } else {
    // grid
    const cols = Math.ceil(Math.sqrt(members.length));
    // 列宽 = 该列最宽卡 + gap;行高 = 该行最高卡 + gap
    const colWidths: number[] = new Array(cols).fill(0);
    const rowHeights: number[] = [];
    members.forEach((c, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      if (c.width > colWidths[col]!) colWidths[col] = c.width;
      if (!rowHeights[row] || c.height > rowHeights[row]!) rowHeights[row] = c.height;
    });
    const colX: number[] = [anchorX];
    for (let i = 1; i < cols; i++) colX.push(colX[i - 1]! + colWidths[i - 1]! + LAYOUT_GAP);
    const rowY: number[] = [anchorY];
    for (let i = 1; i < rowHeights.length; i++) rowY.push(rowY[i - 1]! + rowHeights[i - 1]! + LAYOUT_GAP);
    members.forEach((c, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      // 单元格内左对齐(行内顶部对齐)— grid 模式优先一眼对齐,不做精细中心化
      targets.push({ card: c, x: colX[col]!, y: rowY[row]! });
    });
  }

  // 批量提交
  for (const { card, x, y } of targets) {
    if (card.x === x && card.y === y) continue;
    recordUpdate(card.id, { x: card.x, y: card.y });
    cardStore.updateCard(card.id, { x, y });
    autoSave.markDirty(card.id);
  }
  return true;
}

/**
 * 把若干卡片从它们所在的组里移除。卡片仍在画布上,只是不再属于任何组。
 *   - 空组自动删(走 groupStore.removeCardsFromGroups 内部逻辑);
 *   - 落盘由 pruneGroupsForRemovedCards 同款路径承担(saveGroupsBatch + deleteGroup)。
 *
 * 注意:不要跟 pruneGroupsForRemovedCards 混用。后者用于"卡片被删时"的级联;
 * 本函数用于"卡片仍存在,只是出组"。
 *
 * @returns 真正被改动的组数(updated + deleted)
 */
export function removeCardsFromGroup(cardIds: Iterable<string>): number {
  const { updatedGroupIds, deletedGroupIds } =
    useGroupStore.getState().removeCardsFromGroups(cardIds);
  if (updatedGroupIds.length === 0 && deletedGroupIds.length === 0) return 0;

  for (const gid of deletedGroupIds) {
    void deleteGroup(gid).catch((e) =>
      console.warn(`[groupActions] removeCardsFromGroup.deleteGroup(${gid}) failed:`, e),
    );
  }
  if (updatedGroupIds.length > 0) {
    const rows = updatedGroupIds
      .map((gid) => useGroupStore.getState().getGroup(gid))
      .filter((g): g is NonNullable<typeof g> => g !== undefined)
      .map(groupToRow);
    if (rows.length > 0) {
      void saveGroupsBatch(rows).catch((e) =>
        console.warn("[groupActions] removeCardsFromGroup.saveGroupsBatch failed:", e),
      );
    }
  }
  autoSave.markDirty();
  return updatedGroupIds.length + deletedGroupIds.length;
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
