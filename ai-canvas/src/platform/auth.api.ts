import { lsGet, lsSet, lsRemove } from "./storage";

const TOKEN_KEY = "auth_token";
const USER_KEY = "auth_user";

export interface AuthUser {
  id: number;
  username: string;
  email: string | null;
  memberExpireAt: string | null;
  status: "active" | "inactive" | "expired";
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
  const resp = await fetch(`${getBaseUrl()}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json: ApiResult<T> = await resp.json();
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

export async function apiRedeem(code: string): Promise<{ memberExpireAt: string }> {
  const data = await request<{ memberExpireAt: string }>("POST", "/api/user/redeem", { code });
  const user = getStoredUser();
  if (user) {
    user.memberExpireAt = data.memberExpireAt;
    user.status = "active";
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
