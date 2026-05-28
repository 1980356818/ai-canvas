/**
 * 节点分组(card_groups 表)的持久化 API。镜像 card.api.ts / connection.api.ts 的形态:
 *
 *   • Tauri 路径   → 直接 invoke,组数量天然小,不走 ipcBatched 分片;
 *   • Web 路径     → localStorage polyfill,供浏览器调试模式使用。
 *
 * 设计选择:
 *   • `saveGroupsBatch` 用 upsert 语义,不全量替换(避免误删并发改的组);
 *   • `deleteGroup` 单独提供,跟 deleteCard 对称 —— 解组动作直接调它。
 */

import type { CardGroupRow } from "@/types";
import { isTauri, ensureTauriAPIs, getInvoke } from "./runtime";
import { lsGet, lsSet } from "./storage";

const LS_KEY = (projectId: string) => `groups_${projectId}`;

export async function loadGroups(projectId: string): Promise<CardGroupRow[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    return getInvoke()<CardGroupRow[]>("load_groups", { projectId });
  }
  return lsGet<CardGroupRow[]>(LS_KEY(projectId), []);
}

/**
 * 批量 upsert。groups 数量上限是单项目里的组数,实际不会上千,
 * 因此一次 invoke 即可,不需要 invokeBatched 分片。
 */
export async function saveGroupsBatch(groups: CardGroupRow[]): Promise<void> {
  if (groups.length === 0) return;
  if (isTauri) {
    await ensureTauriAPIs();
    await getInvoke()("save_groups_batch", { groups });
    return;
  }

  const projectId = groups[0]!.project_id;
  const existing = lsGet<CardGroupRow[]>(LS_KEY(projectId), []);
  const map = new Map(existing.map((g) => [g.id, g]));
  for (const g of groups) map.set(g.id, g);
  lsSet(LS_KEY(projectId), Array.from(map.values()));
}

export async function deleteGroup(id: string): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await getInvoke()("delete_group", { id });
    return;
  }

  // Web 路径无法直接按 id 跨项目定位,扫所有 group_ 桶过滤。
  const keys = Object.keys(localStorage).filter((k) => k.startsWith("ai_canvas_groups_"));
  for (const key of keys) {
    try {
      const groups: CardGroupRow[] = JSON.parse(localStorage.getItem(key)!);
      const filtered = groups.filter((g) => g.id !== id);
      if (filtered.length !== groups.length) {
        localStorage.setItem(key, JSON.stringify(filtered));
        break;
      }
    } catch {
      /* skip */
    }
  }
}
