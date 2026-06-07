import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import type { WorkflowTemplate } from "@/types";
import { apiGetTemplates } from "@/platform/templates.api";
import { syncTemplateAssets } from "@/platform/templateAssets";
import { getDisplayUrl, initMediaService } from "@/lib/media";
import { lsGet, lsSet } from "@/platform/storage";
import fallbackTemplates from "@/config/templatesFallback.json";

const CACHE_KEY = "templates_cache_v1";
const FALLBACK = fallbackTemplates as unknown as WorkflowTemplate[];
/** 极境 NAS 模板图 URL 的识别片段。 */
const ASSET_MARK = "/aicanvas-static/templates/";
/**
 * 视频样例不本地化:模板里的样片可达几十 MB,首屏全量下载不划算。视频走远程 NAS
 * 直接 `<video src>` 流式按需加载(getDisplayUrl 对 https 透传);只把图片/封面下到本地
 * (轻、给离线预览)。判定靠扩展名。
 */
const VIDEO_EXT = /\.(mp4|mov|webm|m4v)(\?|#|$)/i;

/** 递归收集模板里所有极境 NAS 图 URL。 */
function collectAssetUrls(list: WorkflowTemplate[]): string[] {
  const out = new Set<string>();
  const walk = (n: unknown) => {
    if (typeof n === "string") {
      if (n.includes(ASSET_MARK) && !VIDEO_EXT.test(n)) out.add(n); // 视频不本地化,流式
    } else if (Array.isArray(n)) {
      n.forEach(walk);
    } else if (n && typeof n === "object") {
      Object.values(n).forEach(walk);
    }
  };
  walk(list);
  return [...out];
}

/** 把命中 map 的远程 URL 换成本地 `asset://` 显示 URL;没命中的保留(远程 URL 走 getDisplayUrl 透传)。 */
function localize<T>(node: T, map: Record<string, string>): T {
  if (typeof node === "string") {
    const rel = map[node];
    return (rel ? getDisplayUrl(rel) : node) as unknown as T;
  }
  if (Array.isArray(node)) {
    return node.map((x) => localize(x, map)) as unknown as T;
  }
  if (node && typeof node === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(node)) {
      o[k] = localize((node as Record<string, unknown>)[k], map);
    }
    return o as unknown as T;
  }
  return node;
}

interface TemplateState {
  templates: WorkflowTemplate[];
  loaded: boolean;
  load: () => Promise<void>;
}

/**
 * 模板来源(服务端化)。定义在画布 server `aicat.template`;图在极境 NAS
 * (`ai.snoworangekeji.cn/aicanvas-static/templates/`,**内容哈希命名**)。
 *
 *   初始 = 本地缓存(上次拉的定义,远程 URL) → 没有就内置 fallback
 *   load() = 拉定义 → Rust `sync_template_assets` 把图下到 `{data_dir}/template-assets/`
 *            (内容哈希:换图=换名=换URL,存在即跳过=下载一次,清孤儿) → 图 URL 换本地 asset://
 *
 * 首屏先用远程 URL 显示(极境宽带快、零 COS),`load()` 完成后切本地文件,之后纯本地、可离线。
 * **不用浏览器缓存**——本地文件夹可控、永不淘汰、哈希命名根治 stale。
 * 非 Tauri 环境(dev 浏览器)拿不到 Rust → 保留远程 URL 渲染。
 */
export const useTemplateStore = create<TemplateState>((set) => ({
  templates: lsGet<WorkflowTemplate[] | null>(CACHE_KEY, null) ?? FALLBACK,
  loaded: false,
  load: async () => {
    let version = "";
    try {
      version = await getVersion();
    } catch {
      // 非 Tauri 环境拿不到版本 → 不传,服务端返全部 active
    }
    try {
      const list = await apiGetTemplates(version);
      if (Array.isArray(list) && list.length > 0) {
        lsSet(CACHE_KEY, list); // 缓存原始(远程 URL)定义,离线兜底
        let display = list;
        try {
          await initMediaService(); // 确保 convertFileSrc / basePath 就绪
          const urls = collectAssetUrls(list);
          if (urls.length > 0) {
            const mappings = await syncTemplateAssets(urls);
            const map: Record<string, string> = {};
            for (const m of mappings) if (m.rel) map[m.url] = m.rel;
            display = localize(list, map);
          }
        } catch (e) {
          // 非 Tauri / 下载失败 → 用远程 URL(getDisplayUrl 对 https 透传)
          console.warn("[templates] 本地化失败,用远程图:", e);
        }
        set({ templates: display, loaded: true });
        return;
      }
    } catch (e) {
      console.warn("[templates] 拉取失败,沿用缓存/内置兜底:", e);
    }
    set({ loaded: true });
  },
}));
