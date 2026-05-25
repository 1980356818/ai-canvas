import { isTauri, ensureTauriAPIs, getInvoke } from "./runtime";
import { lsGet, lsSet } from "./storage";
import { isPlatformVisible } from "@/config/platforms";

export async function getSetting(key: string): Promise<string | null> {
  if (isTauri) {
    await ensureTauriAPIs();
    return getInvoke()<string | null>("get_setting", { key });
  }
  return lsGet<string | null>("setting_" + key, null);
}

export async function setSetting(key: string, value: string): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await getInvoke()("set_setting", { key, value });
    return;
  }
  lsSet("setting_" + key, value);
}

// ── Provider key helpers ────────────────────────────────────

interface KeyEntry {
  id: string;
  name: string;
  key: string;
}

/**
 * Check whether a provider has at least one non-empty API key configured.
 * Checks the multi-key JSON array first, then falls back to legacy single-key.
 */
async function providerHasKey(providerId: string): Promise<boolean> {
  const keysJson = await getSetting(`${providerId}_api_keys`);
  if (keysJson) {
    try {
      const keys: KeyEntry[] = JSON.parse(keysJson);
      if (keys.some((k) => k.key.trim())) return true;
    } catch { /* ignore */ }
  }
  const legacyKey = providerId === "comfly"
    ? await getSetting("openai_api_key")
    : await getSetting(`${providerId}_api_key`);
  return !!legacyKey?.trim();
}

// `getProviderFirstKey` / `readProviderFirstKey` 已统一搬到 `platform/auth.ts`，
// 该模块是全应用 API key 读取的唯一入口（支持 keyTag、双后端透明）。

// ── hasApiKey (cached) ──────────────────────────────────────

let _apiKeyCache: boolean | undefined;

export async function hasApiKey(): Promise<boolean> {
  if (_apiKeyCache === undefined) {
    const providers = ["comfly"];
    if (isPlatformVisible("jijing")) providers.push("jijing");
    const results = await Promise.all(providers.map(providerHasKey));
    _apiKeyCache = results.some(Boolean);
  }
  return _apiKeyCache;
}

export function invalidateApiKeyCache() {
  _apiKeyCache = undefined;
}

const COMFLY_BASE_URL = import.meta.env.VITE_COMFLY_BASE_URL ?? "https://ai.comfly.chat";

export async function migrateApiConfig(): Promise<void> {
  const currentUrl = await getSetting("openai_base_url");
  if (currentUrl) return;
  await setSetting("openai_base_url", COMFLY_BASE_URL);
}
