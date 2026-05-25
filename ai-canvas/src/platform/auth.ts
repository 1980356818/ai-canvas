/**
 * Provider API key / Authorization header 读取的**唯一入口**。
 *
 * 历史背景：早期 `storage.ts` 暴露同步接口 `getProviderAuthHeaders` /
 * `getBrowserFirstKey` / `getAuthHeaders` —— 这些只读 `localStorage`。
 * Tauri 模式下 `SettingsDialog` 通过 `setSetting()` 把 key 存到 Rust sqlite
 * (走 `invoke('set_setting')`)，**根本不写 localStorage**，因此同步接口在
 * Tauri 模式永远拿不到 key，Authorization 头为空，服务端 401 `Missing API
 * Key`。2026-05-25 用户表现：聊天发送时上传媒体 401，promise reject 但 UI
 * loading 状态没复位，看起来像 `gemini-3.1-pro-preview` chat completions 卡死。
 *
 * 根治：所有 fetch 路径必须走本模块的 `async` 入口。后端透明：
 *   - Tauri 模式 → `settings.api::getSetting` → `invoke('get_setting')` → sqlite
 *   - Web 模式   → `settings.api::getSetting` → `lsGet(...)` → localStorage
 *
 * 双后端透明性由 `settings.api.ts` 的 `getSetting/setSetting` 保证；本模块
 * 只负责把"配置层 → key 字符串/Header"这一层抽象出来。
 *
 * `keyTag`：comfly 多槽位（`"default"` / `"gemini_premium"` ...）。
 * 没标签的旧条目视作 `"default"`。
 *
 * **禁止**：
 *   - 直接 `lsGet("setting_*_api_key*")` —— Tauri 模式下 localStorage 必空。
 *   - 同步读取 —— Tauri 走 sqlite 必须 await，没法同步拿到。
 *   - 任何重新封装"同步 Authorization 头"的工具函数。
 *
 * 上述三条 `scripts/check-ipc-guards.{ps1,sh}` 静态扫描会拦下。
 */

import { getSetting } from "./settings.api";

export interface ProviderKeyEntry {
  id: string;
  name: string;
  key: string;
  tag?: string;
}

/**
 * 列出 provider 的全部可用 key。
 *
 * 解析顺序：
 *   1. `${provider}_api_keys` —— 新格式 JSON 数组，过滤 `keyTag`（如指定）并去空。
 *      数组里有任何非空 key 就直接返回，**不再 fallback 到 legacy**。
 *   2. legacy 单 key：`openai_api_key`（comfly 兼容历史命名）或 `${provider}_api_key`。
 *
 * 返回数组里的 key 一定已 trim 且非空；没有可用 key 时返回 `[]`。
 */
export async function readProviderKeys(
  provider?: string,
  keyTag?: string,
): Promise<ProviderKeyEntry[]> {
  const p = provider ?? "comfly";
  const json = await getSetting(`${p}_api_keys`);
  if (json) {
    try {
      const parsed: ProviderKeyEntry[] = JSON.parse(json);
      const filtered = keyTag
        ? parsed.filter((k) => (k.tag ?? "default") === keyTag)
        : parsed;
      const cleaned = filtered.filter((k) => k.key.trim());
      if (cleaned.length > 0) return cleaned;
    } catch {
      // JSON 解析失败 → 视作未配置，落到 legacy 分支。
    }
  }
  const legacyKey = p === "comfly"
    ? await getSetting("openai_api_key")
    : await getSetting(`${p}_api_key`);
  if (legacyKey?.trim()) {
    return [{ id: "legacy", name: "默认", key: legacyKey.trim() }];
  }
  return [];
}

/**
 * 取第一个可用 key 字符串。没有返回空串。
 * 主要给"我只关心有没有 key，不关心 rotation"的调用方用。
 */
export async function readProviderFirstKey(
  provider?: string,
  keyTag?: string,
): Promise<string> {
  const keys = await readProviderKeys(provider, keyTag);
  return keys[0]?.key ?? "";
}

/**
 * 构造 Authorization header。没 key 时返回空对象（不抛错，由调用方根据语义决定
 * 是否提前返回 401 / 给用户提示，例如 `aiProxy` 的 web fallback 会在 keys.length
 * === 0 时返回明确错误体）。
 *
 * 未传 provider 时回退到 `"comfly"`（保留与历史同步版本 `getProviderAuthHeaders`
 * 的默认行为，避免迁移期 listModels/pollTask 等可选 provider 入口炸 TS 类型）。
 */
export async function resolveAuthHeaders(
  provider?: string,
  keyTag?: string,
): Promise<Record<string, string>> {
  const key = await readProviderFirstKey(provider, keyTag);
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/**
 * 记录当前活动 key（持久化到 settings 后端，Tauri 走 sqlite，Web 走 localStorage）。
 *
 * Web fallback 的 key rotation 用到：rotation 命中某个 key 后调用本函数把它升为
 * "首选"。Tauri 模式的 rotation 走 Rust 端 `ai_proxy` 内部，不经过本函数。
 */
export async function setActiveKey(
  provider: string,
  entry: ProviderKeyEntry,
): Promise<void> {
  const { setSetting } = await import("./settings.api");
  await setSetting(`${provider}_active_key_id`, entry.id);
  await setSetting(`${provider}_api_key`, entry.key);
  if (provider === "comfly") {
    await setSetting("openai_api_key", entry.key);
  }
}

/**
 * 自动轮换开关。默认 `true`（仅显式 `"false"` 关闭）。
 */
export async function isAutoRotateEnabled(provider: string): Promise<boolean> {
  const value = await getSetting(`${provider}_auto_rotate`);
  return value !== "false";
}
