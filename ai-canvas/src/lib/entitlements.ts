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
  /** 允许的模板「分类」grant；命中即该分类全部可用（与 templates 取并集） */
  templateCategories: string[];
  /** 允许空白项目 / AI 自由创作（首页 AIPromptInput） */
  allowBlank: boolean;
  /** 允许导入 .aicat */
  allowImport: boolean;
}

/** 无会员/过期/未知一律按"什么都不能创建"的最保守值兜底。 */
export function entitlementsFromUser(user: AuthUser | null): Entitlements {
  const f = (user?.features ?? {}) as TierFeatures;
  const templates: string[] | "*" =
    f.templates === "*" ? "*" : Array.isArray(f.templates) ? f.templates : [];
  const templateCategories = Array.isArray(f.templateCategories) ? f.templateCategories : [];
  return {
    tier: user?.tier ?? null,
    tierName: user?.tierName ?? null,
    isOfficial: !!user?.isOfficial,
    templates,
    templateCategories,
    allowBlank: !!f.allowBlank,
    allowImport: !!f.allowImport,
  };
}

/**
 * 该模板是否允许「使用」(新建/插入)。命中任一即可:
 *   "*" 全放行 · 模板分类在 templateCategories grant 内 · 模板 id 在 templates 白名单内。
 */
export function canUseTemplate(
  ent: Entitlements,
  tpl: { id: string; category: string },
): boolean {
  if (ent.templates === "*") return true;
  if (ent.templateCategories.includes(tpl.category)) return true;
  return ent.templates.includes(tpl.id);
}

/**
 * 该模板是否对当前用户「可见」(展示与否,独立于能否使用 canUseTemplate)。
 * trial 分类是正式模板的试用副本(同封面),正式版用户已有完整模板,不该再看到重复的试用版
 * → 仅对非正式版用户展示 trial;其余分类对所有人可见。
 */
export function canSeeTemplate(ent: Entitlements, tpl: { category: string }): boolean {
  if (tpl.category === "trial") return !ent.isOfficial;
  return true;
}

/**
 * 该模板能否在「画布右键/双击 → 添加模板」菜单里直接插入 = 可见且可用。
 *
 * 这是 in-canvas 快速插入的**唯一门禁口径**:该菜单是纯文本列表、没有「锁」升级位,
 * 所以白名单外的模板必须直接不列(否则试用版用户会看到并直接实例化正式版模板 → 绕过付费墙)。
 *
 * ⚠️ 与首页 `WorkflowGrid` / 新建弹窗 `NewProjectDialog` 的口径**不同**:那两处刻意展示
 * 锁定的正式版模板(canSeeTemplate)作升级引导,各自用 `canUseTemplate` 算 `locked`。
 * 不要把它们改成本函数,否则会丢掉引导升级的锁定卡。
 */
export function canInsertTemplate(
  ent: Entitlements,
  tpl: { id: string; category: string },
): boolean {
  return canSeeTemplate(ent, tpl) && canUseTemplate(ent, tpl);
}
