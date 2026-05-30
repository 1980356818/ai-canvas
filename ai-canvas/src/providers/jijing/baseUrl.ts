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
 *   - 所有线路相关字符串集中在本文件 + config.rs 两处 (vite proxy 已删除,
 *     不再需要同步), 其余代码只通过本模块的工具函数访问, 禁止硬编码新的 URL。
 *
 * 两处必须保持同步 (修改 URL 时一起改):
 *   - 本文件 (浏览器 / Tauri 渲染层)
 *   - src-tauri/src/commands/config.rs::resolve_base_url (Rust 上传/调用层)
 *
 * 历史 (2026-05-30): vite proxy + dev proxy prefix 已删除。前端不再直连上游,
 * 所有上行请求走 httpAdapter → Rust invoke (ai_proxy / http_request /
 * upload_bytes_to_server)。本文件只保留 baseUrl 真相源给 SettingsDialog 展示用。
 */

export const JIJING_OVERSEAS_SETTING_KEY = "jijing_overseas";

export const JIJING_API_CN = "https://api.snoworangekeji.cn";
export const JIJING_API_GLOBAL = "https://global.snoworangekeji.cn";

/**
 * 同步读取「海外用户」开关状态, 基于浏览器 localStorage。
 *
 * 仅用于 UI 层展示当前应使用哪条线路; Tauri 后端走 Rust 端直接读 SQLite
 * (`resolve_base_url`), 不调本函数。复用 platform/settings.api.ts 的 storage
 * key 约定 (前缀 ai_canvas_setting_), 与 setSetting/getSetting 写出来的值兼容。
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
 * Tauri 调用链不读这个值 (走 Rust resolve_base_url + sqlite 配置)。
 */
export function getJiJingBaseUrl(): string {
  return readOverseasFlag() ? JIJING_API_GLOBAL : JIJING_API_CN;
}
