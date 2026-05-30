/**
 * 浏览器 localStorage 的薄包装 (lsGet / lsSet / lsRemove)。
 *
 * 历史 (2026-05-30 根治):
 *   本模块曾经导出 `buildProxyUrl` / `resolveProviderEndpoint` /
 *   `getProviderAbsoluteBaseUrl`, 用于让前端 fetch 直接拼上游 URL。这套设计
 *   靠 `isTauri` 二选一的双语义函数, 是 dev 模式 CORS 报错的根源 (Tauri dev
 *   下 WebView origin 是 vite, 服务端 CORS allowlist 不放行 → preflight 失败)。
 *
 *   现在: **所有上行 HTTP 一律走 Rust invoke** (`platform/httpAdapter.ts` 收口),
 *   前端不再需要任何形态的"拼上游 URL"工具。如果你想拼一个 URL 然后 fetch,
 *   你的方向错了 —— 请改用 httpJson / httpJsonRequest / httpUploadBytes。
 *
 *   2026-05-25 移除 sync key reader 的约束同样有效: 任何同步 localStorage 读
 *   provider key 的代码 (`getProviderAuthHeaders` 等) 都已删除, 走异步
 *   `readProviderKeys` / `resolveAuthHeaders` 入口。
 *
 * `lsGet/lsSet/lsRemove` 仍用于**非 key、非上游 URL** 的浏览器本地缓存
 * (UI 偏好、一次性 banner 隐藏状态、server_base_url 之类的本地配置)。
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
