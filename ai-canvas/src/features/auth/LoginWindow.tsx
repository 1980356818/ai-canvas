import { useState, useCallback, useEffect, type FormEvent } from "react";
import { Loader2, Eye, EyeOff, UserPlus, LogIn, X, Minus, KeyRound } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "@/stores/authStore";
import { cn } from "@/lib/utils";
import loginBrand from "@/assets/login-brand.png";

let appWindow: { minimize(): void } | null = null;
import("@tauri-apps/api/window").then((mod) => {
  appWindow = mod.getCurrentWindow();
});

const INPUT_CLASS =
  "w-full rounded-md border border-[oklch(0.35_0_0)] bg-[oklch(0.18_0_0)] px-3 py-2 text-sm text-foreground outline-none ring-ring placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:border-primary/60";

const HERO: Record<string, { title: string; sub: string }> = {
  login: { title: "欢迎回来", sub: "登录继续使用AI猫" },
  register: { title: "创建账号", sub: "注册一个新的AI猫账号" },
  resetPassword: { title: "重置密码", sub: "通过用户名和邮箱验证身份" },
};

export default function LoginWindow() {
  useEffect(() => {
    invoke("resize_window", {
      width: 720,
      height: 580,
      minWidth: 720,
      minHeight: 580,
      resizable: false,
    });
  }, []);

  const authView = useAuthStore((s) => s.authView);
  const setAuthView = useAuthStore((s) => s.setAuthView);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const resetPassword = useAuthStore((s) => s.resetPassword);
  const loading = useAuthStore((s) => s.loading);
  const error = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);
  const registerSuccess = useAuthStore((s) => s.registerSuccess);

  const isLogin = authView === "login";
  const isRegister = authView === "register";
  const isReset = authView === "resetPassword";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [email, setEmail] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [resetSuccess, setResetSuccess] = useState(false);

  useEffect(() => {
    if (registerSuccess && isLogin) {
      setUsername(registerSuccess.username);
      setPassword(registerSuccess.password);
      useAuthStore.setState({ registerSuccess: null });
    }
  }, [registerSuccess, isLogin]);

  const clearFields = useCallback(() => {
    setUsername("");
    setPassword("");
    setConfirmPwd("");
    setEmail("");
    setShowPwd(false);
    setResetSuccess(false);
    clearError();
  }, [clearError]);

  const goTo = useCallback(
    (view: "login" | "register" | "resetPassword") => {
      setAuthView(view);
      clearFields();
    },
    [setAuthView, clearFields],
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();

    if (isReset) {
      if (!username.trim() || !email.trim() || !password.trim()) return;
      if (password !== confirmPwd) {
        useAuthStore.setState({ error: "两次输入的密码不一致" });
        return;
      }
      if (password.length < 6) {
        useAuthStore.setState({ error: "密码至少需要6位" });
        return;
      }
      try {
        await resetPassword(username, email, password);
        setResetSuccess(true);
      } catch { /* error in store */ }
      return;
    }

    if (!username.trim() || !password.trim()) return;
    if (isRegister) {
      if (password !== confirmPwd) {
        useAuthStore.setState({ error: "两次输入的密码不一致" });
        return;
      }
      if (password.length < 6) {
        useAuthStore.setState({ error: "密码至少需要6位" });
        return;
      }
      if (username.length < 4) {
        useAuthStore.setState({ error: "用户名至少需要4位" });
        return;
      }
    }
    try {
      if (isLogin) await login(username, password);
      else await register(username, password, email || undefined);
    } catch { /* error in store */ }
  };

  const hero = HERO[authView] ?? HERO.login;

  return (
    <div className="dark relative flex h-screen w-screen bg-background text-foreground">
      {/* Drag region */}
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-10 h-9" />

      {/* Window controls */}
      <div className="absolute right-0 top-0 z-20 flex">
        <button
          onClick={() => appWindow?.minimize()}
          className="flex h-8 w-10 items-center justify-center text-white/50 transition-colors hover:bg-white/10 hover:text-white/80"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => void invoke("quit_app")}
          className="flex h-8 w-10 items-center justify-center text-white/50 transition-colors hover:bg-destructive hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Main: left brand + right form */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left — brand area */}
        <div className="w-[280px] shrink-0 overflow-hidden">
          <img src={loginBrand} alt="AI猫" className="h-full w-full object-cover" />
        </div>

        {/* Right — form */}
        <div className="flex flex-1 items-center justify-center px-5">
          <div className="w-full max-w-[280px]">
            <div className="mb-8 text-center">
              <h2 className="text-5xl font-bold">
                <span className="text-login-hero">{hero.title}</span>
              </h2>
              <p className="mt-3 text-sm text-muted-foreground">{hero.sub}</p>
            </div>

            {error && (
              <div className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            {isReset && resetSuccess ? (
              <div className="space-y-4 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10">
                  <KeyRound className="h-6 w-6 text-emerald-500" />
                </div>
                <p className="text-sm text-foreground">密码已重置成功</p>
                <p className="text-xs text-muted-foreground">请使用新密码登录</p>
                <button
                  type="button"
                  onClick={() => goTo("login")}
                  className="mt-2 w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
                >
                  返回登录
                </button>
              </div>
            ) : (
              <>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-foreground">用户名</label>
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="请输入用户名"
                      autoFocus
                      className={INPUT_CLASS}
                    />
                  </div>

                  {(isRegister || isReset) && (
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-foreground">
                        邮箱{isRegister && <span className="text-muted-foreground"> (选填)</span>}
                      </label>
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder={isReset ? "输入注册时的邮箱" : "用于找回密码"}
                        className={INPUT_CLASS}
                      />
                    </div>
                  )}

                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-foreground">
                      {isReset ? "新密码" : "密码"}
                    </label>
                    <div className="relative">
                      <input
                        type={showPwd ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder={isReset ? "请输入新密码" : "请输入密码"}
                        className={cn(INPUT_CLASS, "pr-9")}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPwd(!showPwd)}
                        tabIndex={-1}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  {(isRegister || isReset) && (
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-foreground">确认密码</label>
                      <input
                        type="password"
                        value={confirmPwd}
                        onChange={(e) => setConfirmPwd(e.target.value)}
                        placeholder="再次输入密码"
                        className={INPUT_CLASS}
                      />
                    </div>
                  )}

                  {isLogin && (
                    <div className="-mt-2 text-right">
                      <button
                        type="button"
                        onClick={() => goTo("resetPassword")}
                        className="text-xs text-muted-foreground hover:text-primary"
                      >
                        忘记密码？
                      </button>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loading}
                    className="mt-2 flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {loading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : isReset ? (
                      <KeyRound className="h-4 w-4" />
                    ) : isLogin ? (
                      <LogIn className="h-4 w-4" />
                    ) : (
                      <UserPlus className="h-4 w-4" />
                    )}
                    {isReset ? "重置密码" : isLogin ? "登录" : "注册"}
                  </button>
                </form>

                <div className="mt-6 text-center text-sm text-muted-foreground">
                  {isReset ? (
                    <>
                      想起密码了？
                      <button type="button" onClick={() => goTo("login")} className="ml-1 font-medium text-primary hover:underline">
                        返回登录
                      </button>
                    </>
                  ) : isLogin ? (
                    <>
                      还没有账号？
                      <button type="button" onClick={() => goTo("register")} className="ml-1 font-medium text-primary hover:underline">
                        立即注册
                      </button>
                    </>
                  ) : (
                    <>
                      已有账号？
                      <button type="button" onClick={() => goTo("login")} className="ml-1 font-medium text-primary hover:underline">
                        去登录
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
