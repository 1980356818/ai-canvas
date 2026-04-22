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

let _apiKeyCache: boolean | undefined;

export async function hasApiKey(): Promise<boolean> {
  if (_apiKeyCache === undefined) {
    const checks = [
      getSetting("comfly_api_key"),
      getSetting("openai_api_key"),
    ];
    if (isPlatformVisible("jijing")) {
      checks.push(getSetting("jijing_api_key"));
    }
    const results = await Promise.all(checks);
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
