import { useEffect, useState, type FormEvent } from "react";
import { Loader2, Ticket, KeyRound, Sparkles, X, CheckCircle2, ArrowUpCircle } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useAuthStore } from "@/stores/authStore";

/**
 * App 内"随时升级"弹窗（区别于 RedeemWindow 的全屏激活码墙）。
 * 试用用户点到被锁功能时 openUpgrade(reason) 打开它，输正式版激活码即热升级解锁。
 * 走 authStore.redeem（与激活码墙同一路径，只升不降在服务端兜底）。
 */
export default function UpgradeDialog() {
  const reason = useUIStore((s) => s.upgradeReason);
  const close = useUIStore((s) => s.closeUpgrade);
  const user = useAuthStore((s) => s.user);
  const redeem = useAuthStore((s) => s.redeem);
  const loading = useAuthStore((s) => s.loading);
  const error = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);

  const [code, setCode] = useState("");
  const [done, setDone] = useState(false);

  const open = reason !== null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  // 关闭时复位
  useEffect(() => {
    if (!open) {
      setCode("");
      setDone(false);
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return;
    try {
      await redeem(trimmed);
      setDone(true);
      setTimeout(() => close(), 1500);
    } catch {
      // error 已在 store
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="dark relative w-full max-w-sm rounded-2xl border border-white/[0.08] bg-[#16131e] p-7 text-white shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          onClick={close}
          className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-md text-white/40 transition-colors hover:bg-white/10 hover:text-white/80"
        >
          <X className="h-4 w-4" />
        </button>

        {done ? (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15">
              <CheckCircle2 className="h-7 w-7 text-emerald-400" />
            </div>
            <h2 className="text-lg font-bold">升级成功！</h2>
            <p className="text-sm text-white/50">
              当前等级：{user?.tierName ?? "正式版"}
              {user?.memberExpireAt
                ? ` · 有效期至 ${new Date(user.memberExpireAt).toLocaleDateString("zh-CN")}`
                : ""}
            </p>
          </div>
        ) : (
          <>
            <div className="mb-5 flex flex-col items-center gap-3">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#6d42b0]/20">
                <ArrowUpCircle className="h-7 w-7 text-[#c49bea]" />
              </div>
              <h1 className="text-xl font-bold">升级解锁更多功能</h1>
              <p className="text-center text-sm leading-relaxed text-white/50">
                {reason && reason.length > 0
                  ? reason
                  : "当前为试用版，仅可使用部分功能。输入正式版激活码即可解锁。"}
              </p>
            </div>

            <div className="mb-4 flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.03] px-3.5 py-2.5 text-sm">
              <span className="text-white/40">当前等级</span>
              <span className="font-medium text-white/80">{user?.tierName ?? "试用版"}</span>
            </div>

            {error && (
              <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-400">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-white/60">
                  <Sparkles className="h-3.5 w-3.5 text-[#9b6fd0]" />
                  激活码
                </label>
                <div className="relative">
                  <Ticket className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/20" />
                  <input
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    placeholder="请输入正式版激活码"
                    autoFocus
                    className="w-full rounded-lg border border-white/[0.08] bg-white/[0.06] py-2.5 pl-10 pr-3 font-mono text-sm tracking-[0.15em] text-white/90 outline-none transition-colors placeholder:text-white/20 focus-visible:border-[#5a3888] focus-visible:ring-2 focus-visible:ring-[#6d42b0]"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || !code.trim()}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#6d42b0] px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-[#7a4cc4] disabled:opacity-40"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                立即升级
              </button>
            </form>

            <p className="mt-5 text-center text-xs text-white/25">激活码可向管理员获取</p>
          </>
        )}
      </div>
    </div>
  );
}
