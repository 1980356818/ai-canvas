import { create } from "zustand";
import {
  apiLogin,
  apiRegister,
  apiRedeem,
  apiGetUserStatus,
  apiResetPassword,
  getToken,
  getStoredUser,
  clearAuth,
  setAutoLogin,
  saveCredentials,
  clearSavedCredentials,
  BizError,
  type AuthUser,
} from "@/platform/auth.api";

export type AuthView = "login" | "register" | "redeem" | "resetPassword";

interface AuthState {
  initialized: boolean;
  authenticated: boolean;
  restricted: boolean;
  user: AuthUser | null;
  authView: AuthView;
  loading: boolean;
  error: string | null;
  errorCode: number | null;
  registerSuccess: { username: string; password: string } | null;

  initialize: () => void;
  setAuthView: (view: AuthView) => void;
  login: (username: string, password: string, machineCode: string, forceRebind?: boolean) => Promise<void>;
  register: (username: string, password: string, email?: string) => Promise<void>;
  redeem: (code: string) => Promise<void>;
  resetPassword: (username: string, email: string, newPassword: string) => Promise<void>;
  refreshStatus: () => Promise<void>;
  logout: () => void;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  initialized: false,
  authenticated: false,
  restricted: false,
  user: null,
  authView: "login",
  loading: false,
  error: null,
  errorCode: null,
  registerSuccess: null,

  initialize: () => {
    const token = getToken();
    const user = getStoredUser();
    if (token && user) {
      const restricted = user.status !== "active";
      set({
        initialized: true,
        authenticated: true,
        restricted,
        user,
        authView: restricted ? "redeem" : "login",
      });
      get().refreshStatus().catch(() => {});
    } else {
      set({ initialized: true, authenticated: false });
    }
  },

  setAuthView: (view) => set({ authView: view, error: null }),

  login: async (username: string, password: string, machineCode: string, forceRebind?: boolean) => {
    set({ loading: true, error: null, errorCode: null });
    try {
      const result = await apiLogin(username, password, machineCode, forceRebind);
      // 登录成功 → 应用自己持久化凭据并打开自动登录。
      // 这是凭据记忆的**唯一**出口（以前分散在 LoginWindow 的两个提交处，
      // 漏一处就会出现"记住了 token 却没记住账号密码"的不一致）。所有登录路径
      // （手动登录 / 解绑重试 / 自动登录复用）都经过这里，行为统一。
      saveCredentials(username, password);
      setAutoLogin(true);
      set({
        authenticated: true,
        restricted: result.restricted,
        user: result.user,
        loading: false,
        authView: result.restricted ? "redeem" : "login",
      });
    } catch (e: any) {
      const code = e instanceof BizError ? e.code : null;
      set({ loading: false, error: e.message || "登录失败", errorCode: code });
      throw e;
    }
  },

  register: async (username, password, email) => {
    set({ loading: true, error: null });
    try {
      await apiRegister(username, password, email);
      set({
        loading: false,
        authView: "login",
        registerSuccess: { username, password },
      });
    } catch (e: any) {
      set({ loading: false, error: e.message || "注册失败" });
      throw e;
    }
  },

  redeem: async (code) => {
    set({ loading: true, error: null });
    try {
      const data = await apiRedeem(code);
      const user = get().user;
      if (user) {
        set({
          restricted: false,
          user: {
            ...user,
            memberExpireAt: data.memberExpireAt,
            status: "active",
            tier: data.tier ?? null,
            tierName: data.tierName ?? null,
            tierRank: data.tierRank ?? null,
            isOfficial: data.isOfficial ?? false,
            features: data.features ?? null,
          },
          loading: false,
        });
      }
    } catch (e: any) {
      set({ loading: false, error: e.message || "激活失败" });
      throw e;
    }
  },

  resetPassword: async (username, email, newPassword) => {
    set({ loading: true, error: null });
    try {
      await apiResetPassword(username, email, newPassword);
      set({ loading: false, authView: "login" });
    } catch (e: any) {
      set({ loading: false, error: e.message || "重置失败" });
      throw e;
    }
  },

  refreshStatus: async () => {
    try {
      const user = await apiGetUserStatus();
      const restricted = user.status !== "active";
      set({ user, restricted });
    } catch {
      set({ authenticated: false, user: null });
      clearAuth();
    }
  },

  logout: () => {
    // 显式登出 = "忘记我"：清 token + 清记住的账号密码 + 关自动登录，三者一起，
    // 不留任何会在下次启动自动回填登录框的残留。
    clearAuth();
    clearSavedCredentials();
    setAutoLogin(false);
    set({
      authenticated: false,
      restricted: false,
      user: null,
      authView: "login",
      error: null,
    });
  },

  clearError: () => set({ error: null, errorCode: null }),
}));
