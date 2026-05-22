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

export function getBrowserApiConfig(): { apiKey: string; baseUrl: string } {
  return {
    apiKey: lsGet("setting_openai_api_key", ""),
    baseUrl: lsGet("setting_openai_base_url", ""),
  };
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

interface BrowserKeyEntry {
  id: string;
  name: string;
  key: string;
  tag?: string;
}

/**
 * Resolve the first usable API key for a provider from localStorage.
 * Checks JSON array (new format) → legacy single key → empty string.
 *
 * 可选 keyTag 过滤——Comfly 用 "default" / "gemini_premium" 区分槽位。
 * 没标 tag 的旧条目视作 "default"。
 */
export function getBrowserFirstKey(provider: string, keyTag?: string): string {
  const json = lsGet<string | null>(`setting_${provider}_api_keys`, null);
  if (json) {
    try {
      const parsed: BrowserKeyEntry[] = JSON.parse(json);
      const filtered = keyTag
        ? parsed.filter((k) => (k.tag ?? "default") === keyTag)
        : parsed;
      const first = filtered.find((k) => k.key.trim());
      if (first) return first.key.trim();
    } catch { /* ignore */ }
  }
  const legacyPrefix = provider === "comfly" ? "openai" : provider;
  const legacy = lsGet<string | null>(`setting_${legacyPrefix}_api_key`, null);
  return legacy?.trim() ?? "";
}

/**
 * Build Authorization headers using the first key of the given provider.
 * Falls back to comfly when no provider is specified.
 */
export function getProviderAuthHeaders(provider?: string, keyTag?: string): Record<string, string> {
  const apiKey = getBrowserFirstKey(provider ?? "comfly", keyTag);
  if (!apiKey) return {};
  return { Authorization: `Bearer ${apiKey}` };
}

/** @deprecated Use getProviderAuthHeaders(provider) instead. */
export function getAuthHeaders(): Record<string, string> {
  return getProviderAuthHeaders("comfly");
}
