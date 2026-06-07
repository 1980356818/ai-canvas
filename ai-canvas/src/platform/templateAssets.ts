import { ensureTauriAPIs, getInvoke } from "./runtime";

export interface AssetMapping {
  url: string;
  /** data_dir 下相对路径(如 template-assets/white-bg.<sha16>.jpg);下载失败为 null。 */
  rel: string | null;
}

/**
 * 把模板图下载到本地 `{data_dir}/template-assets/`(内容哈希命名,存在即跳过、清孤儿),
 * 返回 url → 本地相对路径映射。非 Tauri 环境(dev 浏览器)会抛 —— 调用方兜底用远程 URL。
 * 详见 `src-tauri/src/commands/template_assets.rs`。
 */
export async function syncTemplateAssets(urls: string[]): Promise<AssetMapping[]> {
  await ensureTauriAPIs();
  return getInvoke()<AssetMapping[]>("sync_template_assets", { urls });
}
