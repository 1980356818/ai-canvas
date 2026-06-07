import { ArrowUpCircle } from "lucide-react";
import { useMembership } from "@/hooks/useMembership";
import { useUIStore } from "@/stores/uiStore";

/**
 * 标题栏会员升级入口(常驻于全局标题栏右侧,各视图通用)。
 *
 * 仅对非正式版(试用/未开通)用户展示 —— 即「试用期内主动升级」的入口;
 * 点击打开 UpgradeDialog(走 authStore.redeem,只升不降在服务端兜底)。
 * 正式版用户不展示(其等级信息见 设置→账号 会员卡片)。
 *
 * 与会员卡片共用 useMembership 口径,见 lib/membership.ts。
 */
export default function MembershipChip() {
  const { canUpgrade, tierLabel, remainingDays } = useMembership();
  const openUpgrade = useUIStore((s) => s.openUpgrade);

  if (!canUpgrade) return null;

  const daysText =
    remainingDays != null
      ? remainingDays > 0
        ? `剩 ${remainingDays} 天`
        : "即将到期"
      : null;

  return (
    <button
      type="button"
      data-tauri-drag-region="false"
      onClick={() => openUpgrade()}
      title="升级正式版 · 解锁全部功能"
      className="mr-1.5 flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
    >
      <ArrowUpCircle className="h-3.5 w-3.5 shrink-0" />
      <span className="whitespace-nowrap">
        {tierLabel}
        {daysText ? ` · ${daysText}` : ""} · <span className="font-semibold">升级</span>
      </span>
    </button>
  );
}
