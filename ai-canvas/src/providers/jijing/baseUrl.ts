/**
 * 极境 (JiJing) provider 的「国内 / 海外线路」单一真相源。
 *
 * 背景:
 *   极境后端在国内走 api.snoworangekeji.cn (SakuraFrp 国内节点 dx.frp-try.com),
 *   国外用户访问会很慢甚至不通。为此独立开了 global.snoworangekeji.cn 走
 *   SakuraFrp 香港节点 frp-fit.com。「AI 平台 → 极境 → 海外用户」开关用来
 *   控制本端走哪条线路。
 *
 * 设计原则 (统一入口, 不要散点改):
 *   - 单一开关字段 jijing_overseas (boolean string), 同时被前端 settings 与
 *     Rust 端 src-tauri/src/commands/config.rs::resolve_base_url 消费。
 *   - 所有线路相关字符串集中在本文件 + vite.config.ts + config.rs 三处,
 *     其余代码只通过本模块的工具函数访问, 禁止硬编码新的 URL/前缀。
 *
 * 三处必须保持同步 (修改 URL 时一起改):
 *   - 本文件 (浏览器 / Tauri 渲染层)
 *   - vite.config.ts (dev server 静态 proxy)
 *   - src-tauri/src/commands/config.rs::resolve_base_url (Tauri 生产)
 */

export const JIJING_OVERSEAS_SETTING_KEY = "jijing_overseas";

export const JIJING_API_CN = "https://api.snoworangekeji.cn";
export const JIJING_API_GLOBAL = "https://global.snoworangekeji.cn";

/**
 * Dev 模式 vite proxy 的路径前缀。Vite proxy 是静态配置, 所以两条线路必须各占
 * 一个前缀, vite.config.ts 同时声明两个 proxy 入口。
 */
export const JIJING_DEV_PROXY_CN = "/v1-jijing";
export const JIJING_DEV_PROXY_GLOBAL = "/v1-jijing-global";

/**
 * 同步读取「海外用户」开关状态, 基于浏览器 localStorage。
 *
 * 仅供 dev / 浏览器路径使用; Tauri 生产路径走 Rust 端直接读 SQLite, 不调本函数。
 * 复用 platform/settings.api.ts 的 storage key 约定 (前缀 ai_canvas_setting_),
 * 与 setSetting/getSetting 写出来的值兼容。
 */
function readOverseasFlag(): boolean {
  try {
    const raw = localStorage.getItem("ai_canvas_setting_" + JIJING_OVERSEAS_SETTING_KEY);
    if (!raw) return false;
    // setting 存储为 JSON-encoded 字符串 (lsSet 内部走 JSON.stringify), 例如 '"true"'。
    return JSON.parse(raw) === "true";
  } catch {
    return false;
  }
}

/**
 * 当前应使用的极境 API base URL。
 *
 * 主要给 SettingsDialog handleSave 时 registry.setConfig({ baseUrl }) 用,
 * 让 ProviderConfig.baseUrl 字段与实际线路一致 (便于将来 UI 展示 / 调试)。
 * Tauri 生产 ai_proxy 调用链不读这个值 (走 Rust resolve_base_url),
 * dev 模式 buildProxyUrl 也不读这个 (走 getJiJingDevProxyPrefix)。
 */
export function getJiJingBaseUrl(): string {
  return readOverseasFlag() ? JIJING_API_GLOBAL : JIJING_API_CN;
}

/**
 * 当前应使用的 dev proxy 路径前缀。由 src/platform/storage.ts::buildProxyUrl
 * 在浏览器/dev 路径下调用。
 */
export function getJiJingDevProxyPrefix(): string {
  return readOverseasFlag() ? JIJING_DEV_PROXY_GLOBAL : JIJING_DEV_PROXY_CN;
}
