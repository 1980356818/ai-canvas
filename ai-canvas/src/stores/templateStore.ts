import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import type { WorkflowTemplate } from "@/types";
import { apiGetTemplates } from "@/platform/templates.api";
import { syncTemplateAssets } from "@/platform/templateAssets";
import { registerTemplateAssetCache, initMediaService } from "@/lib/media";
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

interface TemplateState {
  templates: WorkflowTemplate[];
  loaded: boolean;
  load: () => Promise<void>;
}

/**
 * 模板来源(服务端化)。定义在画布 server `aicat.template`;图在极境 NAS
 * (`ai.snoworangekeji.cn/aicanvas-static/templates/`,**内容哈希命名**)。
 *
 *   初始 = 本地缓存(上次拉的定义,公网 URL) → 没有就内置 fallback
 *   load() = 拉定义 → Rust `sync_template_assets` 把图下到 `{data_dir}/template-assets/`
 *            (内容哈希:换图=换名=换URL,存在即跳过=下载一次,清孤儿) → 注册「公网 URL→本地副本」
 *            显示缓存(registerTemplateAssetCache),**不改写定义里的 URL**
 *
 * **数据层(模板定义 / 实例化出的卡片 refImages)永远是极境公网 URL** —— 可直接当远端参考图
 * 送上游(零上传、不泄漏本机路径),也能被服务端 SSRF 闸放行。本地副本只作显示缓存:
 * getDisplayUrl 命中缓存就换本机文件显示(离线 / 秒开),否则按公网 URL 透传走网络。
 * 首屏先用公网 URL 显示(极境宽带快、零 COS),`load()` 完成后显示切本地文件。
 * **不用浏览器缓存**——本地文件夹可控、永不淘汰、哈希命名根治 stale。
 * 非 Tauri 环境(dev 浏览器)拿不到 Rust → 数据层公网 URL 照样显示 + 可直接送上游。
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
        lsSet(CACHE_KEY, list); // 缓存原始(公网 URL)定义,离线兜底
        try {
          await initMediaService(); // 确保 convertFileSrc / basePath 就绪
          const urls = collectAssetUrls(list);
          if (urls.length > 0) {
            const mappings = await syncTemplateAssets(urls);
            // 只注册「公网 URL → 本地副本」显示缓存,**不改写定义里的 URL**:
            // 数据层保留公网 URL(可直接当远端参考图、零上传、不泄漏本机路径),
            // getDisplayUrl 命中缓存时才换本机文件显示(离线 / 秒开)。详见 lib/media.ts 缓存块注释。
            for (const m of mappings) if (m.rel) registerTemplateAssetCache(m.url, m.rel);
          }
        } catch (e) {
          // 非 Tauri / 下载失败 → 数据层公网 URL 照样显示(getDisplayUrl 透传)+ 可直接送上游
          console.warn("[templates] 模板资源本地化失败,用远程图:", e);
        }
        set({ templates: list, loaded: true });
        return;
      }
    } catch (e) {
      console.warn("[templates] 拉取失败,沿用缓存/内置兜底:", e);
    }
    set({ loaded: true });
  },
}));
