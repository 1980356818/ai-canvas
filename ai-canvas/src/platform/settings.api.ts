import { isTauri, ensureTauriAPIs, getInvoke } from "./runtime";
import { lsGet, lsSet } from "./storage";

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

let _apiKeyCache: string | null | undefined;

export async function hasApiKey(): Promise<boolean> {
  if (_apiKeyCache === undefined) {
    _apiKeyCache = await getSetting("openai_api_key");
  }
  return !!_apiKeyCache;
}

export function invalidateApiKeyCache() {
  _apiKeyCache = undefined;
}

const COMFLY_API_KEY = import.meta.env.VITE_COMFLY_API_KEY ?? "";
const COMFLY_BASE_URL = import.meta.env.VITE_COMFLY_BASE_URL ?? "https://ai.comfly.chat";

export async function migrateApiConfig(): Promise<void> {
  const currentUrl = await getSetting("openai_base_url");
  if (currentUrl && currentUrl.includes("comfly.chat")) return;

  await setSetting("openai_api_key", COMFLY_API_KEY);
  await setSetting("openai_base_url", COMFLY_BASE_URL);
  invalidateApiKeyCache();
}
