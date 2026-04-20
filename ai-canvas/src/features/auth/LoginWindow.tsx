import { useState, useCallback, type FormEvent } from "react";
import { Loader2, Eye, EyeOff, UserPlus, LogIn } from "lucide-react";
import { useAuthStore } from "@/stores/authStore";
import { cn } from "@/lib/utils";
import catPawImg from "@/assets/cat-paw.png";

export default function LoginWindow() {
  const authView = useAuthStore((s) => s.authView);
  const setAuthView = useAuthStore((s) => s.setAuthView);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const loading = useAuthStore((s) => s.loading);
  const error = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);

  const isLogin = authView === "login";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [email, setEmail] = useState("");
  const [showPwd, setShowPwd] = useState(false);

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
      if (isLogin) {
        await login(username, password);
      } else {
        await register(username, password, email || undefined);
      }
    } catch {
      // error already set in store
    }
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-gradient-to-br from-background via-muted/30 to-background">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 shadow-lg">
        {/* Header */}
        <div className="mb-6 flex flex-col items-center gap-2">
          <img src={catPawImg} alt="" className="h-10 w-10 opacity-80" />
          <h1 className="text-xl font-semibold text-foreground">AI猫</h1>
          <p className="text-sm text-muted-foreground">
            {isLogin ? "登录以继续使用" : "创建新账号"}
          </p>
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
              用户名
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="请输入用户名"
              autoFocus
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none ring-ring placeholder:text-muted-foreground/50 focus-visible:ring-2"
            />
          </div>

          {!isLogin && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                邮箱 <span className="text-muted-foreground/50">(选填)</span>
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="用于找回密码"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none ring-ring placeholder:text-muted-foreground/50 focus-visible:ring-2"
              />
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              密码
            </label>
            <div className="relative">
              <input
                type={showPwd ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入密码"
                className="w-full rounded-md border border-input bg-background px-3 py-2 pr-9 text-sm text-foreground outline-none ring-ring placeholder:text-muted-foreground/50 focus-visible:ring-2"
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
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                确认密码
              </label>
              <input
                type="password"
                value={confirmPwd}
                onChange={(e) => setConfirmPwd(e.target.value)}
                placeholder="再次输入密码"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none ring-ring placeholder:text-muted-foreground/50 focus-visible:ring-2"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className={cn(
              "mt-2 flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50",
            )}
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

        {/* Switch */}
        <div className="mt-5 text-center text-sm text-muted-foreground">
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
  );
}
