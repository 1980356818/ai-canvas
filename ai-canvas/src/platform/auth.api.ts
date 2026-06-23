import { lsGet, lsSet, lsRemove } from "./storage";
import { httpJson } from "./httpAdapter";

const TOKEN_KEY = "auth_token";
const USER_KEY = "auth_user";

/** 服务端 tier_def.features 下发的能力清单（核心维度=允许的项目模板）。 */
export interface TierFeatures {
  /** 允许的模板 id 列表；字符串 "*" = 全部 */
  templates?: string[] | "*";
  /** 允许的模板「分类」grant；命中即该分类全部可用（与 templates 取并集） */
  templateCategories?: string[];
  allowBlank?: boolean;
  allowImport?: boolean;
  [k: string]: unknown;
}

export interface AuthUser {
  id: number;
  username: string;
  email: string | null;
  memberExpireAt: string | null;
  status: "active" | "inactive" | "expired";
  /** 会员等级 tier_key（无会员/过期为 null） */
  tier?: string | null;
  tierName?: string | null;
  tierRank?: number | null;
  isOfficial?: boolean;
  features?: TierFeatures | null;
}

export interface LoginResult {
  token: string;
  restricted: boolean;
  user: AuthUser;
}

interface ApiResult<T> {
  code: number;
  msg: string;
  data: T;
}

function getBaseUrl(): string {
  return lsGet("server_base_url", "http://101.37.80.236");
}

export function getToken(): string | null {
  return lsGet<string | null>(TOKEN_KEY, null);
}

export function setToken(token: string) {
  lsSet(TOKEN_KEY, token);
}

export function getStoredUser(): AuthUser | null {
  return lsGet<AuthUser | null>(USER_KEY, null);
}

function setStoredUser(user: AuthUser) {
  lsSet(USER_KEY, user);
}

export function clearAuth() {
  lsRemove(TOKEN_KEY);
  lsRemove(USER_KEY);
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export class BizError extends Error {
  code: number;
  constructor(code: number, msg: string) {
    super(msg);
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // 走 Rust 端 http_request command —— ai-canvas 全局规约 "前端不直接 fetch 上游",
  // 详见 src/platform/httpAdapter.ts 顶部注释。这里 body 是 object 时 httpJson
  // 会自动 JSON 序列化 + 注入 Content-Type, 无 body 时不传。
  const resp = await httpJson({
    url: `${getBaseUrl()}${path}`,
    method: method as "GET" | "POST" | "PUT" | "DELETE",
    headers: authHeaders(),
    body,
  });

  let json: ApiResult<T>;
  try {
    json = JSON.parse(resp.body);
  } catch {
    throw new BizError(
      resp.status || -1,
      `服务端响应非 JSON (HTTP ${resp.status}): ${resp.body.slice(0, 200)}`,
    );
  }
  if (json.code !== 0) {
    throw new BizError(json.code, json.msg || "请求失败");
  }
  return json.data;
}

export async function apiLogin(
  username: string,
  password: string,
  machineCode: string,
  forceRebind?: boolean,
): Promise<LoginResult> {
  const data = await request<LoginResult>("POST", "/api/auth/login", {
    username,
    password,
    machineCode,
    deviceInfo: navigator.userAgent,
    forceRebind: forceRebind || undefined,
  });
  setToken(data.token);
  setStoredUser(data.user);
  return data;
}

export async function apiRegister(
  username: string,
  password: string,
  email?: string,
): Promise<LoginResult> {
  const data = await request<LoginResult>("POST", "/api/auth/register", {
    username,
    password,
    email: email || undefined,
  });
  setToken(data.token);
  setStoredUser(data.user);
  return data;
}

export interface RedeemResult {
  memberExpireAt: string;
  tier?: string | null;
  tierName?: string | null;
  tierRank?: number | null;
  isOfficial?: boolean;
  features?: TierFeatures | null;
  action?: "upgrade" | "renew";
  days?: number;
}

export async function apiRedeem(code: string): Promise<RedeemResult> {
  const data = await request<RedeemResult>("POST", "/api/user/redeem", { code });
  const user = getStoredUser();
  if (user) {
    user.memberExpireAt = data.memberExpireAt;
    user.status = "active";
    user.tier = data.tier ?? user.tier;
    user.tierName = data.tierName ?? user.tierName;
    user.tierRank = data.tierRank ?? user.tierRank;
    user.isOfficial = data.isOfficial ?? user.isOfficial;
    user.features = data.features ?? user.features;
    setStoredUser(user);
  }
  return data;
}

export async function apiGetUserStatus(): Promise<AuthUser> {
  const data = await request<AuthUser>("GET", "/api/user/status");
  setStoredUser(data);
  return data;
}

export async function apiResetPassword(
  username: string,
  email: string,
  newPassword: string,
): Promise<void> {
  await request<null>("POST", "/api/auth/reset-password", {
    username,
    email,
    newPassword,
  });
}

// ── 登录凭据记忆（应用自管，单一真相） ───────────────────────────────────────
// 本应用是登录框唯一的"填表人"。账号 + 密码作为**一个对象**整存整取，所以只会
// "要么都填、要么都不填"，不可能半填。写入只发生在 authStore.login 成功后（唯一
// 出口），清除发生在 logout，二者成对。
//
// 桌面端(Tauri/Windows)还在 Rust 侧关掉了 WebView2 自带的密码自动保存 + 通用表单
// 自动填充(见 src-tauri/src/lib.rs::disable_webview2_autofill)，避免内置 Edge 的
// 密码管理器作为第二个"填表人"和这里抢登录框 —— 那正是"用户名空着、密码还在"
// 半填 bug 的根因。
const SAVED_CRED_KEY = "saved_credentials";
const AUTO_LOGIN_KEY = "auto_login";

export function getSavedCredentials(): { username: string; password: string } | null {
  return lsGet<{ username: string; password: string } | null>(SAVED_CRED_KEY, null);
}

export function saveCredentials(username: string, password: string) {
  lsSet(SAVED_CRED_KEY, { username, password });
}

export function clearSavedCredentials() {
  lsRemove(SAVED_CRED_KEY);
}

export function getAutoLogin(): boolean {
  return lsGet<boolean>(AUTO_LOGIN_KEY, false);
}

export function setAutoLogin(enabled: boolean) {
  lsSet(AUTO_LOGIN_KEY, enabled);
}

export async function apiChangePassword(
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  await request<null>("POST", "/api/user/change-password", {
    oldPassword,
    newPassword,
  });
}

export interface DeviceInfo {
  bound: boolean;
  machineCode: string | null;
  deviceInfo: string | null;
  boundAt: string | null;
  unbindLimit: number;
  unbindUsed: number;
  unbindRemaining: number;
}

export async function apiGetDeviceInfo(): Promise<DeviceInfo> {
  return request<DeviceInfo>("GET", "/api/user/device-info");
}

export async function apiUnbindDevice(
  newMachineCode: string,
  deviceInfo?: string,
): Promise<void> {
  await request<null>("POST", "/api/user/unbind-device", {
    newMachineCode,
    deviceInfo,
  });
}
