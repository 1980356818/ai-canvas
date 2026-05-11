import { useState, useCallback, useEffect, useRef, type FormEvent } from "react";
import { Loader2, Eye, EyeOff, UserPlus, LogIn, X, Minus, KeyRound, User, Lock, Mail, ShieldCheck, Monitor } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "@/stores/authStore";
import {
  getSavedCredentials,
  saveCredentials,
  getAutoLogin,
  setAutoLogin as persistAutoLogin,
} from "@/platform/auth.api";
import { isTauri } from "@/platform/runtime";
import { cn } from "@/lib/utils";
import loginBrand from "@/assets/login-brand.png";

async function getMachineCode(): Promise<string | undefined> {
  if (!isTauri) return undefined;
  try {
    return await invoke<string>("get_machine_code");
  } catch {
    return undefined;
  }
}

let appWindow: { minimize(): void } | null = null;
import("@tauri-apps/api/window").then((mod) => {
  appWindow = mod.getCurrentWindow();
});

const INPUT_CLASS =
  "w-full rounded-md border border-white/[0.08] bg-white/[0.06] py-2 pl-9 pr-3 text-sm text-white/90 outline-none placeholder:text-white/25 focus-visible:ring-2 focus-visible:ring-[#6d42b0] focus-visible:border-[#5a3888] transition-colors";

const INPUT_ICON_CLASS = "pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-white/25";

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
  const errorCode = useAuthStore((s) => s.errorCode);
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
  const [unbinding, setUnbinding] = useState(false);
  const autoLoginAttempted = useRef(false);

  const isDeviceMismatch = errorCode === 40303;
  const isUnbindLimit = errorCode === 40304 || errorCode === 40305;

  useEffect(() => {
    const saved = getSavedCredentials();
    if (saved) {
      setUsername(saved.username);
      setPassword(saved.password);
    }
  }, []);

  useEffect(() => {
    if (autoLoginAttempted.current) return;
    if (!isLogin) return;
    if (!getAutoLogin()) return;
    const saved = getSavedCredentials();
    if (saved && saved.username && saved.password) {
      autoLoginAttempted.current = true;
      getMachineCode().then((mc) => {
        login(saved.username, saved.password, mc).catch(() => {});
      });
    }
  }, [isLogin, login]);

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

  const handleUnbindAndRetry = async () => {
    setUnbinding(true);
    try {
      const mc = await getMachineCode();
      if (!mc) {
        useAuthStore.setState({ error: "无法获取设备标识", errorCode: null });
        return;
      }
      await login(username, password, mc, true);
      saveCredentials(username, password);
      persistAutoLogin(true);
    } catch {
      // error already set by authStore.login
    } finally {
      setUnbinding(false);
    }
  };

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
      if (isLogin) {
        const mc = await getMachineCode();
        await login(username, password, mc);
        saveCredentials(username, password);
        persistAutoLogin(true);
      } else {
        await register(username, password, email || undefined);
      }
    } catch { /* error in store */ }
  };

  const hero = (HERO[authView] ?? HERO.login)!;

  return (
    <div className="dark relative flex h-screen w-screen bg-[#16131e] text-white">
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
          className="flex h-8 w-10 items-center justify-center text-white/50 transition-colors hover:bg-red-500/80 hover:text-white"
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
              <p className="mt-3 text-sm tracking-[0.15em] text-white/45">{hero.sub}</p>
            </div>

            {error && (
              <div className="mb-4 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400">
                {isDeviceMismatch ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5">
                      <Monitor className="h-4 w-4 shrink-0" />
                      <span>当前设备与已绑定设备不同</span>
                    </div>
                    <p className="text-xs text-red-400/70">
                      你的帐号已绑定在另一台设备上，你可以解绑旧设备并绑定当前设备（每月限 1 次）。
                    </p>
                    <button
                      type="button"
                      disabled={unbinding}
                      onClick={handleUnbindAndRetry}
                      className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md bg-amber-500/20 px-3 py-1.5 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-500/30 disabled:opacity-50"
                    >
                      {unbinding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Monitor className="h-3 w-3" />}
                      解绑旧设备并绑定此设备
                    </button>
                  </div>
                ) : isUnbindLimit ? (
                  <div className="space-y-1">
                    <span>{error}</span>
                    <p className="text-xs text-red-400/70">请联系管理员解绑设备。</p>
                  </div>
                ) : (
                  error
                )}
              </div>
            )}

            {isReset && resetSuccess ? (
              <div className="space-y-4 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10">
                  <KeyRound className="h-6 w-6 text-emerald-500" />
                </div>
                <p className="text-sm text-white/90">密码已重置成功</p>
                <p className="text-xs text-white/45">请使用新密码登录</p>
                <button
                  type="button"
                  onClick={() => goTo("login")}
                  className="mt-2 w-full rounded-md bg-[#6d42b0] px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
                >
                  返回登录
                </button>
              </div>
            ) : (
              <>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                  {/* 用户名 */}
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-white/70">用户名</label>
                    <div className="relative">
                      <User className={INPUT_ICON_CLASS} />
                      <input
                        type="text"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="请输入用户名"
                        autoFocus
                        className={INPUT_CLASS}
                      />
                    </div>
                  </div>

                  {/* 邮箱 (注册/重置) */}
                  {(isRegister || isReset) && (
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-white/70">
                        邮箱{isRegister && <span className="text-white/30"> (选填)</span>}
                      </label>
                      <div className="relative">
                        <Mail className={INPUT_ICON_CLASS} />
                        <input
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder={isReset ? "输入注册时的邮箱" : "用于找回密码"}
                          className={INPUT_CLASS}
                        />
                      </div>
                    </div>
                  )}

                  {/* 密码 */}
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-white/70">
                      {isReset ? "新密码" : "密码"}
                    </label>
                    <div className="relative">
                      <Lock className={INPUT_ICON_CLASS} />
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
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/60"
                      >
                        {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  {/* 确认密码 (注册/重置) */}
                  {(isRegister || isReset) && (
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-white/70">确认密码</label>
                      <div className="relative">
                        <ShieldCheck className={INPUT_ICON_CLASS} />
                        <input
                          type="password"
                          value={confirmPwd}
                          onChange={(e) => setConfirmPwd(e.target.value)}
                          placeholder="再次输入密码"
                          className={INPUT_CLASS}
                        />
                      </div>
                    </div>
                  )}

                  {/* 忘记密码 */}
                  {isLogin && (
                    <div className="-mt-1 text-right">
                      <button
                        type="button"
                        onClick={() => goTo("resetPassword")}
                        className="text-xs text-white/30 hover:text-[#af85dd]"
                      >
                        忘记密码？
                      </button>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loading}
                    className="mt-1 flex w-full items-center justify-center gap-2 rounded-md bg-[#6d42b0] px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
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

                <div className="mt-6 text-center text-sm text-white/30">
                  {isReset ? (
                    <>
                      想起密码了？
                      <button type="button" onClick={() => goTo("login")} className="ml-1 font-medium text-[#9b6fd0] hover:underline">
                        返回登录
                      </button>
                    </>
                  ) : isLogin ? (
                    <>
                      还没有账号？
                      <button type="button" onClick={() => goTo("register")} className="ml-1 font-medium text-[#9b6fd0] hover:underline">
                        立即注册
                      </button>
                    </>
                  ) : (
                    <>
                      已有账号？
                      <button type="button" onClick={() => goTo("login")} className="ml-1 font-medium text-[#9b6fd0] hover:underline">
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
