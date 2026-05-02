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

const PROXY_PREFIX: Record<string, string> = {
  comfly: "/v1-proxy",
  jijing: "/v1-jijing",
};

export function buildProxyUrl(endpoint: string, provider?: string): string {
  const prefix = (provider && PROXY_PREFIX[provider]) || "/v1-proxy";
  return prefix + endpoint;
}

interface BrowserKeyEntry {
  id: string;
  name: string;
  key: string;
}

/**
 * Resolve the first usable API key for a provider from localStorage.
 * Checks JSON array (new format) → legacy single key → empty string.
 */
export function getBrowserFirstKey(provider: string): string {
  const json = lsGet<string | null>(`setting_${provider}_api_keys`, null);
  if (json) {
    try {
      const parsed: BrowserKeyEntry[] = JSON.parse(json);
      const first = parsed.find((k) => k.key.trim());
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
export function getProviderAuthHeaders(provider?: string): Record<string, string> {
  const apiKey = getBrowserFirstKey(provider ?? "comfly");
  if (!apiKey) return {};
  return { Authorization: `Bearer ${apiKey}` };
}

/** @deprecated Use getProviderAuthHeaders(provider) instead. */
export function getAuthHeaders(): Record<string, string> {
  return getProviderAuthHeaders("comfly");
}
