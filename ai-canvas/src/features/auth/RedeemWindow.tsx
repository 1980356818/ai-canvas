import { useState, type FormEvent } from "react";
import { Loader2, Ticket, LogOut, CheckCircle2, X, Minus, Square } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "@/stores/authStore";
import { cn } from "@/lib/utils";
import appIcon from "@/assets/app-icon.png";

let appWindow: { minimize(): void; toggleMaximize(): void } | null = null;
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
    ? "账号尚未激活，请兑换会员码"
    : "会员已过期，请兑换续费";

  if (!restricted && success) {
    return (
      <div className="flex h-screen w-screen flex-col bg-background text-foreground">
        <div data-tauri-drag-region className="flex h-9 shrink-0 items-center">
          <span className="pl-4 text-sm font-semibold text-foreground/70">AI猫</span>
          <div data-tauri-drag-region className="flex-1" />
          <button onClick={() => appWindow?.minimize()} className="flex h-7 w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"><Minus className="h-3.5 w-3.5" /></button>
          <button onClick={() => appWindow?.toggleMaximize()} className="flex h-7 w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"><Square className="h-3 w-3" /></button>
          <button onClick={() => void invoke("quit_app")} className="flex h-7 w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"><X className="h-3.5 w-3.5" /></button>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 shadow-lg">
            <div className="flex flex-col items-center gap-4">
              <CheckCircle2 className="h-12 w-12 text-emerald-500" />
              <h2 className="text-lg font-semibold text-foreground">兑换成功！</h2>
              <p className="text-sm text-muted-foreground">
                会员有效期至 {user?.memberExpireAt ? new Date(user.memberExpireAt).toLocaleDateString("zh-CN") : ""}
              </p>
              <p className="text-xs text-muted-foreground">正在进入应用...</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      <div data-tauri-drag-region className="flex h-9 shrink-0 items-center">
        <span className="pl-4 text-sm font-semibold text-foreground/70">AI猫</span>
        <div data-tauri-drag-region className="flex-1" />
        <button onClick={() => appWindow?.minimize()} className="flex h-7 w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"><Minus className="h-3.5 w-3.5" /></button>
        <button onClick={() => appWindow?.toggleMaximize()} className="flex h-7 w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"><Square className="h-3 w-3" /></button>
        <button onClick={() => void invoke("quit_app")} className="flex h-7 w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"><X className="h-3.5 w-3.5" /></button>
      </div>
      <div className="flex flex-1 items-center justify-center">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 shadow-lg">
        {/* Header */}
        <div className="mb-6 flex flex-col items-center gap-2">
          <img src={appIcon} alt="" className="h-10 w-10 opacity-80" />
          <h1 className="text-xl font-semibold text-foreground">兑换会员</h1>
          <p className="text-sm text-muted-foreground">{statusLabel}</p>
        </div>

        {/* User info */}
        <div className="mb-4 flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
          <span className="text-sm text-foreground">
            当前用户: <span className="font-medium">{user?.username}</span>
          </span>
          <button
            type="button"
            onClick={logout}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive"
          >
            <LogOut className="h-3 w-3" />
            退出
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              兑换码
            </label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="请输入兑换码"
              autoFocus
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono tracking-wider text-foreground outline-none ring-ring placeholder:text-muted-foreground/50 focus-visible:ring-2"
            />
          </div>

          <button
            type="submit"
            disabled={loading || !code.trim()}
            className={cn(
              "mt-2 flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50",
            )}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Ticket className="h-4 w-4" />
            )}
            兑换
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          兑换码可向管理员获取
        </p>
      </div>
      </div>
    </div>
  );
}
