/**
 * Web 模式的低阶 localStorage 包装 + dev 模式的 vite proxy URL 构造 + 上行
 * HTTP endpoint 的统一解析入口。
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

import { isTauri } from "./runtime";
import {
  getJiJingBaseUrl,
  getJiJingDevProxyPrefix,
} from "@/providers/jijing/baseUrl";
import {
  getComflyBaseUrl,
  getComflyDevProxyPrefix,
} from "@/providers/comfly/baseUrl";

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

// ── Endpoint 解析:Web/Dev 走 vite proxy,Tauri 直连绝对 URL ─────────────────
//
// 历史坑(2026-05-29 修复):
//   `media.ts::uploadViaFetch` 用 `buildProxyUrl("/v1/files/upload", "jijing")`
//   拼成 `/v1-jijing/v1/files/upload` 相对路径,在 Tauri **生产**安装包里
//   `fetch("/v1-jijing/...")` 被 WebView 协议 (`tauri://localhost`) 解释,
//   找不到这个本地资源 -> Tauri 默认 SPA fallback 把所有未知路径全返
//   `index.html`(HTTP 200 + HTML body)-> 前端 `JSON.parse(htmlBody)` 炸,
//   表现为 `unhandledrejection 上传响应解析失败: <!doctype html><html lang="zh-CN">...`。
//
//   Web/Dev 模式因为有 vite proxy 兜底,同样的相对路径会被代理转发,所以
//   bug 不在 dev 复现,只在生产挂。
//
// 规范化结论:
//   - **新代码** 一律调 `resolveProviderEndpoint`,运行时按 isTauri 自动二选一。
//   - **buildProxyUrl 仍可用,但 Tauri 模式下调用直接 throw**(下面 guard),
//     防止任何"以为只在 dev 跑" 的代码静默在生产里炸。
//   - 现存 `ai.api.ts` 里的 buildProxyUrl 调用都在 `if (isTauri) { ...; return }`
//     之后,不受 guard 影响;但建议后续迁移到 resolveProviderEndpoint 统一收口。

/**
 * Dev / 浏览器模式下,把 endpoint 拼到该 provider 在 vite 配置中的代理前缀上。
 *
 * **不要在 Tauri 模式下调用本函数** —— 相对路径 fetch 在 Tauri 生产 WebView 里
 * 会被 SPA fallback 拦成 index.html。Tauri 模式应该走 `invoke("ai_proxy", ...)`
 * (业务请求) 或 `resolveProviderEndpoint` (前端必须自己 fetch 的场景,如
 * media multipart 上传)。
 *
 * 本函数在 Tauri 模式下直接 throw,防止误用悄悄返回坏 URL。
 */
export function buildProxyUrl(endpoint: string, provider?: string): string {
  if (isTauri) {
    throw new Error(
      `[storage.buildProxyUrl] Tauri 模式下禁止调用 (endpoint=${endpoint}, provider=${provider ?? ""}) — ` +
        `相对路径 fetch 会被 WebView SPA fallback 接管。请改用 resolveProviderEndpoint 或 invoke("ai_proxy").`,
    );
  }
  if (provider === "jijing") return getJiJingDevProxyPrefix() + endpoint;
  if (provider === "comfly") return getComflyDevProxyPrefix() + endpoint;
  // 未识别的 provider 兜底走 comfly 前缀, 跟历史行为一致 (老代码里 default)。
  return getComflyDevProxyPrefix() + endpoint;
}

/**
 * 返回某 provider 当前的绝对 base URL (不含末尾 `/`)。Tauri 模式下需要前端直连
 * 后端时用 (例如 multipart 上传不走 `ai_proxy`)。
 *
 * 与 Rust 端 `commands/config.rs::default_base_url` + sqlite `{provider}_base_url`
 * 的行为对齐 —— **但本函数当前不读 sqlite,只读 baseUrl.ts 真相源** (jijing
 * 还读 localStorage 的 overseas 开关)。这意味着用户在 SettingsDialog 自定义了
 * `comfly_base_url` 的话,本函数不会感知;只对官方默认线路有效。
 *
 * 当前唯一调用方 `media.ts::uploadViaFetch` 只在 WebView-only URL (data:/blob:/
 * 前端 asset) 命中时走,此场景不涉及"用户自定义 base url" —— 用了自定义 URL 的
 * 用户也是在用同一个 provider 的代理后端,`/v1/files/upload` 仍在那个域名上。
 * 若将来扩展到读用户自定义,把本函数改成 `async` 走 `getSetting()` 即可。
 */
export function getProviderAbsoluteBaseUrl(provider?: string): string {
  if (provider === "jijing") return getJiJingBaseUrl();
  if (provider === "comfly") return getComflyBaseUrl();
  // 兜底:跟 buildProxyUrl 老逻辑保持"未识别 = comfly" 一致, 避免空字符串拼出
  // 一个无 host 的 URL 在 fetch 里直接报 TypeError。
  return getComflyBaseUrl();
}

/**
 * 上行 HTTP 请求的统一 URL 解析入口。
 *
 * - **Tauri 模式** → 绝对 URL (`https://<provider-host>/<endpoint>`),
 *   直连后端,不依赖 vite proxy (生产里没有)。
 * - **Web / Dev 模式** → 相对 URL (`/<proxy-prefix>/<endpoint>`),由
 *   vite dev server 代理到真实后端,顺便规避浏览器 CORS。
 *
 * 跟 `buildProxyUrl` 的关系:`buildProxyUrl` 只返代理前缀 (Web/Dev 专用),
 * 在 Tauri 模式下会 throw。`resolveProviderEndpoint` 是**新代码的统一入口**,
 * 自动按运行环境选对的策略。
 *
 * `endpoint` 必须以 `/` 开头,例如 `/v1/files/upload`,跟 `aiProxy` 接受的形态
 * 一致。
 */
export function resolveProviderEndpoint(endpoint: string, provider?: string): string {
  if (!endpoint.startsWith("/")) {
    throw new Error(
      `[storage.resolveProviderEndpoint] endpoint 必须以 / 开头 (收到: ${endpoint})`,
    );
  }
  if (isTauri) {
    return getProviderAbsoluteBaseUrl(provider) + endpoint;
  }
  if (provider === "jijing") return getJiJingDevProxyPrefix() + endpoint;
  if (provider === "comfly") return getComflyDevProxyPrefix() + endpoint;
  return getComflyDevProxyPrefix() + endpoint;
}
