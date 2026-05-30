/**
 * Comfly provider 的 base URL 真相源。结构与 `providers/jijing/baseUrl.ts` 对称,
 * 任何要拼上游 HTTP URL 的前端代码都从这里取常量, 不再各处硬编码。
 *
 * Comfly 当前只有一条线路 (`https://ai.comfly.chat`), 但保留这个独立模块给将来
 * 扩多线路 / 自定义 base url 留接口, 也跟极境的「真相源单点化」结构保持一致。
 *
 * ## 散落点同步清单 (修改 URL 时必须一起改)
 *
 *   - 本文件 (前端 UI 层)
 *   - `src-tauri/src/commands/config.rs::default_base_url` (Rust 兜底)
 *   - `src-tauri/src/db/migrations.rs` 初始 sqlite 种子值
 *   - `src/features/overlays/SettingsDialog.tsx` 表单默认值
 *
 * 历史 (2026-05-30): vite proxy + dev proxy prefix 已删除。前端不再直连上游,
 * 所有上行请求走 httpAdapter → Rust invoke。Tauri 调用链下 ai_proxy 不读本模块,
 * 由 Rust `read_full_api_config` 从 sqlite 读用户配置 + Rust 端 default_base_url 兜底。
 * 本模块只保留给 UI 层展示 / SettingsDialog 默认值用。
 */

/**
 * Comfly 官方 API base URL。改这里时记得同步上面注释列的所有散落点。
 * `import.meta.env.VITE_COMFLY_BASE_URL` 由 CI build (.github/workflows/build.yml)
 * 注入, 允许 fork / 自托管 build 在不改源码的前提下覆盖默认 base URL。
 */
export const COMFLY_API_DEFAULT: string =
  (import.meta.env.VITE_COMFLY_BASE_URL as string | undefined) ?? "https://ai.comfly.chat";

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
