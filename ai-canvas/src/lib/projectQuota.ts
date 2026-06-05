import { useAuthStore } from "@/stores/authStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { entitlementsFromUser, canCreateProject } from "@/lib/entitlements";

/**
 * 创建项目前的配额闸：试用版 `features.maxProjects` 限制（0/缺省 = 不限）。
 * 超额时弹「升级」弹窗并返回 false；所有新建项目入口在创建前调用它。
 *
 * 命令式读 store（非 React hook），可在事件回调里直接用。配额按当前活跃
 * （未删除）项目数算，回收站不计入。
 *
 * ⚠️ 与其它门禁一样是客户端软约束（见 entitlements.ts 顶部安全说明）。
 *
 * @returns true=可继续创建；false=已超额（已弹升级窗，调用方应直接 return）
 */
export function ensureProjectQuota(): boolean {
  const ent = entitlementsFromUser(useAuthStore.getState().user);
  const count = useProjectStore.getState().projects.length;
  if (canCreateProject(ent, count)) return true;
  useUIStore.getState().openUpgrade(
    `${ent.tierName ?? "试用版"}最多创建 ${ent.maxProjects} 个项目，当前已有 ${count} 个。升级正式版后不限项目数。`,
  );
  return false;
}
