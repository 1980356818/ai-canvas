/**
 * Comfly provider 的 base URL 真相源。结构与 `providers/jijing/baseUrl.ts` 对称,
 * 任何要拼上行 HTTP URL 的前端代码都从这里取常量 / 函数, 不再各处硬编码。
 *
 * Comfly 当前只有一条线路 (`https://ai.comfly.chat`), 但保留这个独立模块给将来
 * 扩多线路 / 自定义 base url 留接口, 也跟极境的「真相源单点化」结构保持一致。
 *
 * ## 散落点同步清单 (修改 URL 时必须一起改, 否则会出现 dev/prod 走两套地址的灾难)
 *
 *   - 本文件 (前端 / Tauri 渲染层)
 *   - `vite.config.ts` const COMFLY_API (dev server 静态 proxy)
 *   - `src-tauri/src/commands/config.rs::default_base_url` (Tauri 生产兜底)
 *   - `src-tauri/src/db/migrations.rs` 初始 sqlite 种子值
 *   - `src/features/overlays/SettingsDialog.tsx` 表单默认值
 *
 * Tauri 生产路径下 `ai_proxy` invoke 不读本模块 — 由 Rust 端 read_full_api_config
 * 从 sqlite 读用户配置 + fallback 到 Rust 端 default_base_url。本模块给的是
 * **前端 fetch 路径** 在没有 sqlite 时的合理默认 (Web/dev 模式) 以及 Tauri 模式
 * 下需要前端直连后端 (如 `media.ts::uploadViaFetch` 处理 WebView-only URL) 时
 * 用的真相源。
 */

/**
 * Comfly 官方 API base URL。改这里时记得同步上面注释列的所有散落点。
 * `import.meta.env.VITE_COMFLY_BASE_URL` 由 CI build (.github/workflows/build.yml)
 * 注入, 允许 fork / 自托管 build 在不改源码的前提下覆盖默认 base URL。
 */
export const COMFLY_API_DEFAULT: string =
  (import.meta.env.VITE_COMFLY_BASE_URL as string | undefined) ?? "https://ai.comfly.chat";

/**
 * Dev 模式 vite proxy 的路径前缀。跟 `vite.config.ts::proxy` 里声明的入口一一对应,
 * 改前缀必须同步 vite 配置, 否则 dev server 不会代理。
 */
export const COMFLY_DEV_PROXY: string = "/v1-proxy";

/**
 * 当前应使用的 Comfly base URL。
 *
 * 当前只有官方一条线路, 直接返常量。保留这个函数是为了跟 `getJiJingBaseUrl()`
 * 的调用形态对称, 以及给将来用户在 SettingsDialog 自定义 base URL 时 (读取
 * `comfly_base_url` setting) 留扩展位。
 */
export function getComflyBaseUrl(): string {
  return COMFLY_API_DEFAULT;
}

/**
 * 当前应使用的 Comfly dev proxy 前缀。由 `platform/storage.ts::buildProxyUrl`
 * 在浏览器/dev 路径下调用。
 */
export function getComflyDevProxyPrefix(): string {
  return COMFLY_DEV_PROXY;
}
