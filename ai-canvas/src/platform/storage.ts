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

export function getAuthHeaders(): Record<string, string> {
  const { apiKey } = getBrowserApiConfig();
  if (!apiKey) return {};
  return { Authorization: `Bearer ${apiKey}` };
}
