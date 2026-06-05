import type { AuthUser, TierFeatures } from "@/platform/auth.api";

/**
 * 客户端功能门禁的归一化能力对象，由服务端下发的 tier features 推导。
 * 试用版的核心限制 = 只能用 `templates` 里的项目模板；blank/导入也按位开关。
 *
 * ⚠️ 安全：桌面端生成直连上游 AI、不过 license 服务器，本门禁是"客户端约束"，
 * 技术上可被破解；真正不可绕过需把生成走服务端代理（见 docs/会员等级体系设计.md §8）。
 */
export interface Entitlements {
  tier: string | null;
  tierName: string | null;
  isOfficial: boolean;
  /** 允许的项目模板 id 列表；"*" = 全部 */
  templates: string[] | "*";
  /** 允许空白项目 / AI 自由创作（首页 AIPromptInput） */
  allowBlank: boolean;
  /** 允许导入 .aicat */
  allowImport: boolean;
  /** 项目数上限，0 = 不限 */
  maxProjects: number;
}

/** 无会员/过期/未知一律按"什么都不能创建"的最保守值兜底。 */
export function entitlementsFromUser(user: AuthUser | null): Entitlements {
  const f = (user?.features ?? {}) as TierFeatures;
  const templates: string[] | "*" =
    f.templates === "*" ? "*" : Array.isArray(f.templates) ? f.templates : [];
  return {
    tier: user?.tier ?? null,
    tierName: user?.tierName ?? null,
    isOfficial: !!user?.isOfficial,
    templates,
    allowBlank: !!f.allowBlank,
    allowImport: !!f.allowImport,
    maxProjects: typeof f.maxProjects === "number" ? f.maxProjects : 0,
  };
}

/** 该模板 id 是否允许使用。 */
export function canUseTemplate(ent: Entitlements, templateId: string): boolean {
  if (ent.templates === "*") return true;
  return ent.templates.includes(templateId);
}

/**
 * 项目数配额：是否还能再创建一个项目。
 * `maxProjects <= 0` 表示不限（正式版）；`currentCount` 为当前活跃（未删除）项目数。
 */
export function canCreateProject(ent: Entitlements, currentCount: number): boolean {
  return ent.maxProjects <= 0 || currentCount < ent.maxProjects;
}
