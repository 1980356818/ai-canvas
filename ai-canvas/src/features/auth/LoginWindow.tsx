import { useState, useCallback, useEffect, type FormEvent } from "react";
import { Loader2, Eye, EyeOff, UserPlus, LogIn, X, Minus } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "@/stores/authStore";
import { cn } from "@/lib/utils";
import loginBrand from "@/assets/login-brand.png";

let appWindow: { minimize(): void; toggleMaximize(): void } | null = null;
import("@tauri-apps/api/window").then((mod) => {
  appWindow = mod.getCurrentWindow();
});

export default function LoginWindow() {
  useEffect(() => {
    invoke("resize_window", {
      width: 640,
      height: 580,
      minWidth: 640,
      minHeight: 580,
      resizable: false,
    });
  }, []);

  const authView = useAuthStore((s) => s.authView);
  const setAuthView = useAuthStore((s) => s.setAuthView);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const loading = useAuthStore((s) => s.loading);
  const error = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);
  const registerSuccess = useAuthStore((s) => s.registerSuccess);

  const isLogin = authView === "login";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [email, setEmail] = useState("");
  const [showPwd, setShowPwd] = useState(false);

  useEffect(() => {
    if (registerSuccess && isLogin) {
      setUsername(registerSuccess.username);
      setPassword(registerSuccess.password);
      useAuthStore.setState({ registerSuccess: null });
    }
  }, [registerSuccess, isLogin]);

  const switchMode = useCallback(() => {
    setAuthView(isLogin ? "register" : "login");
    setUsername("");
    setPassword("");
    setConfirmPwd("");
    setEmail("");
  }, [isLogin, setAuthView]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();
    if (!username.trim() || !password.trim()) return;
    if (!isLogin) {
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
    } catch {
      /* error in store */
    }
  };

  const inputClass =
    "w-full rounded-md border border-[oklch(0.35_0_0)] bg-[oklch(0.18_0_0)] px-3 py-2 text-sm text-foreground outline-none ring-ring placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:border-primary/60";

  return (
    <div className="dark flex h-screen w-screen flex-col bg-background text-foreground">
      {/* Title bar */}
      <div data-tauri-drag-region className="flex h-9 shrink-0 items-center">
        <span className="pl-4 text-sm font-semibold text-foreground/70">AI猫</span>
        <div data-tauri-drag-region className="flex-1" />
        <button
          onClick={() => appWindow?.minimize()}
          className="flex h-7 w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => void invoke("quit_app")}
          className="flex h-7 w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Main: left brand + right form */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left — brand area */}
        <div className="w-[220px] shrink-0 overflow-hidden">
          <img src={loginBrand} alt="AI猫" className="h-full w-full object-cover" />
        </div>

        {/* Right — login form */}
        <div className="flex flex-1 items-center justify-center px-5">
          <div className="w-full max-w-[280px]">
            <div className="mb-8 text-center">
              <h2 className="text-5xl font-bold">
                <span className="text-login-hero">{isLogin ? "欢迎回来" : "创建账号"}</span>
              </h2>
              <p className="mt-3 text-sm text-muted-foreground">
                {isLogin ? "登录继续使用AI猫" : "注册一个新的AI猫账号"}
              </p>
            </div>

            {error && (
              <div className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground">用户名</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="请输入用户名"
                  autoFocus
                  className={inputClass}
                />
              </div>

              {!isLogin && (
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-foreground">
                    邮箱 <span className="text-muted-foreground">(选填)</span>
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="用于找回密码"
                    className={inputClass}
                  />
                </div>
              )}

              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground">密码</label>
                <div className="relative">
                  <input
                    type={showPwd ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="请输入密码"
                    className={cn(inputClass, "pr-9")}
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

              {!isLogin && (
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-foreground">确认密码</label>
                  <input
                    type="password"
                    value={confirmPwd}
                    onChange={(e) => setConfirmPwd(e.target.value)}
                    placeholder="再次输入密码"
                    className={inputClass}
                  />
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : isLogin ? (
                  <LogIn className="h-4 w-4" />
                ) : (
                  <UserPlus className="h-4 w-4" />
                )}
                {isLogin ? "登录" : "注册"}
              </button>
            </form>

            <div className="mt-6 text-center text-sm text-muted-foreground">
              {isLogin ? "还没有账号？" : "已有账号？"}
              <button
                type="button"
                onClick={switchMode}
                className="ml-1 font-medium text-primary hover:underline"
              >
                {isLogin ? "立即注册" : "去登录"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
