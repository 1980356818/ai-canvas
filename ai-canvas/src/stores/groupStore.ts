import { create } from "zustand";
import type { CardGroup } from "@/types";

export type { CardGroup } from "@/types";

/**
 * 节点分组(card_groups)状态。
 *
 * ─── 设计与 cardStore 对齐的部分 ───────────────────────────────
 *  • `version` —— 任何 Map mutation 都 +1,下游订阅它而非整个 Map(后者每次
 *    add/remove 都换引用,等于"任何写都全量重算")。
 *  • 不变式:**一卡只能属一组**。所有写入路径(addGroup/updateGroup)会自动
 *    把传入 cardIds 中已在其它组的卡片"挤"出原组(maintainSingleMembership)。
 *
 * ─── 跟 cardStore 的差异 ───────────────────────────────────────
 *  • cardStore 用 layoutVersion / dataVersion 双计数器 —— 因为卡片"几何变化"
 *    和"数据变化"是两类完全不同的下游(视口剔除 vs 数据流传播)。组没有这种
 *    双面性,几何 = cards 的派生,数据 = 标题/颜色,放一起一个 version 即可。
 *  • 组数量天然小(单项目通常 < 50),不做空间索引,GroupLayer 直接遍历过滤。
 *
 * ─── 反例 / 正例 ───────────────────────────────────────────────
 *   // ❌ 每次写都重渲
 *   const groups = useGroupStore((s) => s.groups);
 *
 *   // ✅ 订阅版本号 + imperative 取 Map
 *   const version = useGroupStore((s) => s.version);
 *   useEffect(() => {
 *     const groups = useGroupStore.getState().groups;
 *     ...
 *   }, [version]);
 *
 *   // ✅ 单组渲染
 *   const group = useGroupStore((s) => s.groups.get(groupId));
 */
interface GroupState {
  groups: Map<string, CardGroup>;
  version: number;

  setGroups: (groups: CardGroup[]) => void;
  addGroup: (group: CardGroup) => void;
  removeGroup: (id: string) => void;
  updateGroup: (id: string, partial: Partial<CardGroup>) => void;

  /**
   * 删/挤一批卡片出所有组(连线删除、卡片删除会调用)。
   * cardIds 为空的组会被一并删除(返回值含这些 groupId,调用方按需走持久化)。
   *
   * @returns 受影响的组 id 列表(含被自动删的空组)
   */
  removeCardsFromGroups: (cardIds: Iterable<string>) => {
    updatedGroupIds: string[];
    deletedGroupIds: string[];
  };

  getGroup: (id: string) => CardGroup | undefined;
  getGroupsByProject: (projectId: string) => CardGroup[];
  getGroupByCardId: (cardId: string) => CardGroup | undefined;

  clear: () => void;
}

/** 把传入 cardIds 中已属其它组的卡片从原组挤出。返回受影响的"原组" id 列表。 */
function maintainSingleMembership(
  groups: Map<string, CardGroup>,
  newGroupId: string,
  newCardIds: string[],
): { mutatedGroups: Map<string, CardGroup>; evictedGroupIds: string[] } {
  const set = new Set(newCardIds);
  const evicted: string[] = [];
  let mutatedGroups = groups;

  for (const [gid, g] of groups) {
    if (gid === newGroupId) continue;
    const keep = g.cardIds.filter((cid) => !set.has(cid));
    if (keep.length !== g.cardIds.length) {
      if (mutatedGroups === groups) mutatedGroups = new Map(groups);
      // 原组空了 → 直接删,不留空壳
      if (keep.length === 0) {
        mutatedGroups.delete(gid);
      } else {
        mutatedGroups.set(gid, {
          ...g,
          cardIds: keep,
          updatedAt: new Date().toISOString(),
        });
      }
      evicted.push(gid);
    }
  }

  return { mutatedGroups, evictedGroupIds: evicted };
}

export const useGroupStore = create<GroupState>((set, get) => ({
  groups: new Map(),
  version: 0,

  setGroups: (groups) => {
    const map = new Map<string, CardGroup>();
    for (const g of groups) map.set(g.id, g);
    set((s) => ({ groups: map, version: s.version + 1 }));
  },

  addGroup: (group) =>
    set((s) => {
      const seeded = new Map(s.groups);
      seeded.set(group.id, group);
      const { mutatedGroups } = maintainSingleMembership(seeded, group.id, group.cardIds);
      return { groups: mutatedGroups, version: s.version + 1 };
    }),

  removeGroup: (id) =>
    set((s) => {
      if (!s.groups.has(id)) return s;
      const next = new Map(s.groups);
      next.delete(id);
      return { groups: next, version: s.version + 1 };
    }),

  updateGroup: (id, partial) =>
    set((s) => {
      const cur = s.groups.get(id);
      if (!cur) return s;
      const updated: CardGroup = {
        ...cur,
        ...partial,
        updatedAt: new Date().toISOString(),
      };
      const seeded = new Map(s.groups);
      seeded.set(id, updated);

      // 仅当 cardIds 变化时维护成员唯一性
      const cardIdsChanged =
        partial.cardIds !== undefined && partial.cardIds !== cur.cardIds;
      const final = cardIdsChanged
        ? maintainSingleMembership(seeded, id, updated.cardIds).mutatedGroups
        : seeded;
      return { groups: final, version: s.version + 1 };
    }),

  removeCardsFromGroups: (cardIds) => {
    const ids = new Set(cardIds);
    if (ids.size === 0) {
      return { updatedGroupIds: [], deletedGroupIds: [] };
    }
    const updatedGroupIds: string[] = [];
    const deletedGroupIds: string[] = [];
    let mutated: Map<string, CardGroup> | null = null;

    for (const [gid, g] of get().groups) {
      const keep = g.cardIds.filter((cid) => !ids.has(cid));
      if (keep.length === g.cardIds.length) continue;
      if (!mutated) mutated = new Map(get().groups);

      if (keep.length === 0) {
        mutated.delete(gid);
        deletedGroupIds.push(gid);
      } else {
        mutated.set(gid, {
          ...g,
          cardIds: keep,
          updatedAt: new Date().toISOString(),
        });
        updatedGroupIds.push(gid);
      }
    }

    if (mutated) {
      set((s) => ({ groups: mutated!, version: s.version + 1 }));
    }
    return { updatedGroupIds, deletedGroupIds };
  },

  getGroup: (id) => get().groups.get(id),

  getGroupsByProject: (projectId) =>
    Array.from(get().groups.values()).filter((g) => g.projectId === projectId),

  getGroupByCardId: (cardId) => {
    for (const g of get().groups.values()) {
      if (g.cardIds.includes(cardId)) return g;
    }
    return undefined;
  },

  clear: () =>
    set((s) => ({
      groups: new Map(),
      version: s.version + 1,
    })),
}));
