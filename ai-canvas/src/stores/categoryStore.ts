import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import { apiGetCategories } from "@/platform/categories.api";
import { lsGet, lsSet } from "@/platform/storage";
import fallbackCategories from "@/config/categoriesFallback.json";
import type { TemplateCategory } from "@/config/templateCategories";

const CACHE_KEY = "template_categories_cache_v1";
const FALLBACK = fallbackCategories as TemplateCategory[];

interface CategoryState {
  categories: TemplateCategory[];
  loaded: boolean;
  load: () => Promise<void>;
}

/**
 * 模板分组(注册表)来源(服务端化)。组名/顺序/上下架在画布 server
 * `aicat.template_category`,客户端拉 `GET /api/template-categories`。
 *
 *   初始 = 本地缓存(上次拉的) → 没有就内置 `categoriesFallback.json`(永不空,首屏不闪)
 *   load() = 拉服务端 → 写缓存 → set
 *
 * 失败(非 Tauri / 断网)沿用缓存或内置兜底。模板按 `category` slug 归到这里的某个 key;
 * 未知 slug 在消费点回退显示原 slug(`?? key`)。
 */
export const useCategoryStore = create<CategoryState>((set) => ({
  categories: lsGet<TemplateCategory[] | null>(CACHE_KEY, null) ?? FALLBACK,
  loaded: false,
  load: async () => {
    let version = "";
    try {
      version = await getVersion();
    } catch {
      // 非 Tauri 环境拿不到版本 → 不传
    }
    try {
      const list = await apiGetCategories(version);
      if (Array.isArray(list) && list.length > 0) {
        lsSet(CACHE_KEY, list);
        set({ categories: list, loaded: true });
        return;
      }
    } catch (e) {
      console.warn("[categories] 拉取失败,沿用缓存/内置兜底:", e);
    }
    set({ loaded: true });
  },
}));
