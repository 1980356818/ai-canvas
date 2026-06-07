import type { AuthUser } from "@/platform/auth.api";

/**
 * 会员状态的展示视图，由服务端下发的 user 字段归一化而来。
 *
 * 与 entitlements(功能门禁)分工:entitlements 决定"能用什么"(模板/空白/导入),
 * membership 决定"展示什么等级 / 到期 / 是否给升级入口"。标题栏会员标签
 * (MembershipChip)与 设置→账号 会员卡片共用此口径,避免两处各算各的。
 *
 * 详见会员等级体系设计:docs/会员等级体系设计.md。相关:lib/entitlements.ts。
 */
export interface MembershipView {
  /** 等级 key(无会员/过期为 null) */
  tier: string | null;
  /** 等级展示名;无名时按是否有会员兜底 */
  tierLabel: string;
  /** 是否正式版(VIP 等),由服务端 isOfficial 下发 */
  isOfficial: boolean;
  /** 会员到期时间(ISO 字符串),无则 null */
  expireAt: string | null;
  /** 距到期剩余天数(向上取整,最小 0);无到期时间为 null */
  remainingDays: number | null;
  /** 是否展示「升级/兑换正式版」入口 —— 非正式版用户(试用/未开通)即为转化目标 */
  canUpgrade: boolean;
}

const DAY_MS = 86_400_000;

/** 距某 ISO 时间还剩多少天(向上取整,最小 0);空/非法返回 null。 */
function daysUntil(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil((ms - now) / DAY_MS));
}

/**
 * 把 user 归一化为会员展示视图。
 * now 默认取当前时间,可注入便于测试(避免依赖系统时钟)。
 */
export function membershipFromUser(
  user: AuthUser | null,
  now: number = Date.now(),
): MembershipView {
  const isOfficial = !!user?.isOfficial;
  const tier = user?.tier ?? null;
  const expireAt = user?.memberExpireAt ?? null;
  return {
    tier,
    tierLabel: user?.tierName ?? (tier ? "会员" : "未开通会员"),
    isOfficial,
    expireAt,
    remainingDays: daysUntil(expireAt, now),
    canUpgrade: !isOfficial,
  };
}

/** 会员到期日的统一展示格式(zh-CN 本地日期);空/非法显示 "—"。 */
export function formatExpireDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("zh-CN");
}
