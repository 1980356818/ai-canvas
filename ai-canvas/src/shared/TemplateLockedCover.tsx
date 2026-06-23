import { Lock } from "lucide-react";
import { LOCK_BADGE_LABEL } from "@/config/membershipCopy";

/**
 * 模板卡「锁定」遮罩：半透明压暗 + 居中「升级可用」角标。
 * 首页 WorkflowGrid 与新建弹窗 NewProjectDialog 的锁定模板卡共用
 * （原为两处完全相同的内联 JSX，抽出以消除重复、统一角标文案）。
 */
export function TemplateLockedCover() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/30">
      <div className="flex items-center gap-1 rounded-full bg-black/65 px-2 py-1 text-[9px] font-medium text-white/90">
        <Lock className="h-2.5 w-2.5" /> {LOCK_BADGE_LABEL}
      </div>
    </div>
  );
}
