/**
 * Web 模式的低阶 localStorage 包装 + dev 模式的 vite proxy URL 构造。
 *
 * 注意（2026-05-25 重构）：本模块**不再**暴露任何 API key 读取接口。早期版本
 * 有同步的 `getProviderAuthHeaders` / `getBrowserFirstKey` / `getAuthHeaders` /
 * `getBrowserApiConfig`，都只读 localStorage —— Tauri 模式下 SettingsDialog
 * 把 key 存在 sqlite，这些同步接口永远拿不到，导致 fetch 路径 Authorization
 * 头为空 -> 服务端 401。**所有 API key 读取一律走 `platform/auth.ts` 异步入口**
 * （`readProviderKeys` / `readProviderFirstKey` / `resolveAuthHeaders`），后端
 * 透明（Tauri sqlite / Web localStorage）。`scripts/check-ipc-guards.{ps1,sh}`
 * 静态扫描禁止在本模块或任何其他地方重新引入同步 key 读取。
 *
 * `lsGet/lsSet/lsRemove` 仍可用于**非 key 场景**的浏览器本地缓存（UI 偏好、
 * 一次性 banner 隐藏状态等），Tauri 模式那些场景也照样在 localStorage 中。
 */

const LS_PREFIX = "ai_canvas_";

export function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function lsSet(key: string, value: unknown) {
  localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
}

export function lsRemove(key: string) {
  localStorage.removeItem(LS_PREFIX + key);
}

import { getJiJingDevProxyPrefix } from "@/providers/jijing/baseUrl";

// Provider → dev 模式下 vite proxy 的静态前缀映射。
// 极境的 cn / global 双线路在 src/providers/jijing/baseUrl.ts 单点决策, 不进此表。
const PROXY_PREFIX: Record<string, string> = {
  comfly: "/v1-proxy",
};

/**
 * Dev / 浏览器模式下,把 endpoint 拼到该 provider 在 vite 配置中的代理前缀上。
 * 真正的 Tauri 生产路径走 invoke("ai_proxy", ...), 由 Rust 端直连后端,
 * 不会走到本函数。
 */
export function buildProxyUrl(endpoint: string, provider?: string): string {
  if (provider === "jijing") return getJiJingDevProxyPrefix() + endpoint;
  const prefix = (provider && PROXY_PREFIX[provider]) || "/v1-proxy";
  return prefix + endpoint;
}
