import { useState, type FormEvent } from "react";
import { Loader2, Ticket, LogOut, CheckCircle2, X, Minus, KeyRound, Sparkles, User } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "@/stores/authStore";

let appWindow: { minimize(): void } | null = null;
import("@tauri-apps/api/window").then((mod) => {
  appWindow = mod.getCurrentWindow();
});

export default function RedeemWindow() {
  const user = useAuthStore((s) => s.user);
  const redeem = useAuthStore((s) => s.redeem);
  const logout = useAuthStore((s) => s.logout);
  const loading = useAuthStore((s) => s.loading);
  const error = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);
  const restricted = useAuthStore((s) => s.restricted);

  const [code, setCode] = useState("");
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return;

    try {
      await redeem(trimmed);
      setSuccess(true);
    } catch {
      // error set in store
    }
  };

  const statusLabel = user?.status === "inactive"
    ? "账号尚未激活，请输入激活码"
    : "会员已过期，请输入激活码续费";

  if (!restricted && success) {
    return (
      <div className="dark relative flex h-screen w-screen items-center justify-center bg-[#16131e] text-white">
        <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-10 h-9" />
        <div className="absolute right-0 top-0 z-20 flex">
          <button onClick={() => appWindow?.minimize()} className="flex h-8 w-10 items-center justify-center text-white/50 transition-colors hover:bg-white/10 hover:text-white/80"><Minus className="h-3.5 w-3.5" /></button>
          <button onClick={() => void invoke("quit_app")} className="flex h-8 w-10 items-center justify-center text-white/50 transition-colors hover:bg-red-500/80 hover:text-white"><X className="h-3.5 w-3.5" /></button>
        </div>

        <div className="redeem-card-glow relative w-full max-w-sm rounded-2xl border border-white/[0.08] bg-white/[0.04] p-8 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-5">
            <div className="redeem-success-ring flex h-16 w-16 items-center justify-center rounded-full">
              <CheckCircle2 className="h-8 w-8 text-emerald-400" />
            </div>
            <h2 className="text-xl font-bold text-white">激活成功！</h2>
            <p className="text-sm text-white/50">
              会员有效期至 {user?.memberExpireAt ? new Date(user.memberExpireAt).toLocaleDateString("zh-CN") : ""}
            </p>
            <div className="flex items-center gap-2 text-xs text-white/30">
              <Loader2 className="h-3 w-3 animate-spin" />
              正在进入应用...
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dark relative flex h-screen w-screen items-center justify-center bg-[#16131e] text-white">
      {/* Ambient glow */}
      <div className="redeem-ambient pointer-events-none absolute inset-0 overflow-hidden" />

      {/* Drag region */}
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-10 h-9" />

      {/* Window controls */}
      <div className="absolute right-0 top-0 z-20 flex">
        <button onClick={() => appWindow?.minimize()} className="flex h-8 w-10 items-center justify-center text-white/50 transition-colors hover:bg-white/10 hover:text-white/80"><Minus className="h-3.5 w-3.5" /></button>
        <button onClick={() => void invoke("quit_app")} className="flex h-8 w-10 items-center justify-center text-white/50 transition-colors hover:bg-red-500/80 hover:text-white"><X className="h-3.5 w-3.5" /></button>
      </div>

      {/* Main card */}
      <div className="redeem-card-glow relative z-10 w-full max-w-sm rounded-2xl border border-white/[0.08] bg-white/[0.04] p-8 backdrop-blur-sm">
        {/* Scanning line */}
        <div className="redeem-scan-line pointer-events-none absolute inset-x-0 top-0 h-full overflow-hidden rounded-2xl" />

        {/* Header */}
        <div className="relative mb-7 flex flex-col items-center gap-3">
          <div className="redeem-icon-ring flex h-14 w-14 items-center justify-center rounded-full">
            <KeyRound className="h-6 w-6 text-[#c49bea]" />
          </div>
          <h1 className="text-2xl font-bold">
            <span className="text-login-hero">激活会员</span>
          </h1>
          <p className="text-sm tracking-wide text-white/40">{statusLabel}</p>
        </div>

        {/* User info bar */}
        <div className="mb-5 flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.03] px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <User className="h-3.5 w-3.5 text-white/25" />
            <span className="text-sm text-white/60">
              <span className="font-medium text-white/80">{user?.username}</span>
            </span>
          </div>
          <button
            type="button"
            onClick={logout}
            className="flex items-center gap-1 text-xs text-white/30 transition-colors hover:text-red-400"
          >
            <LogOut className="h-3 w-3" />
            退出
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-white/60">
              <span className="flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-[#9b6fd0]" />
                激活码
              </span>
            </label>
            <div className="relative">
              <Ticket className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/20" />
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="请输入激活码"
                autoFocus
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.06] py-2.5 pl-10 pr-3 font-mono text-sm tracking-[0.2em] text-white/90 outline-none placeholder:text-white/20 transition-colors focus-visible:border-[#5a3888] focus-visible:ring-2 focus-visible:ring-[#6d42b0]"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || !code.trim()}
            className="redeem-btn group relative mt-1 flex w-full items-center justify-center gap-2 overflow-hidden rounded-lg px-4 py-2.5 text-sm font-medium text-white transition-all disabled:opacity-40"
          >
            <span className="relative z-10 flex items-center gap-2">
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
              激活
            </span>
          </button>
        </form>

        <p className="mt-5 text-center text-xs text-white/25">
          激活码可向管理员获取
        </p>
      </div>
    </div>
  );
}
