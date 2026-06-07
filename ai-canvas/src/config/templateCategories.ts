/**
 * 模板浏览分类(面向用户)。**分组注册表现已服务端驱动**:组名/顺序/上下架存画布 server
 * `aicat.template_category`,客户端经 `useCategoryStore` 拉取(GET /api/template-categories)+
 * `categoriesFallback.json` 离线兜底。加/改分类 = 后台改库,**桌面端零发版**。
 *
 * 本文件只留:类型定义、保留 slug 常量、由分类列表派生 label/order 映射的小工具。
 * 模板的 `category` 字段存某个分类的 `key`(slug,对齐服务端 cat_key)。
 */
export interface TemplateCategory {
  /** 存进模板定义 `category` 字段的稳定 slug(对齐服务端 cat_key)。 */
  key: string;
  /** 界面显示名。 */
  label: string;
  /** 排序权重,越小越靠前。 */
  sort: number;
}

/**
 * 保留 slug:这两个分类在代码里有特殊行为(非纯展示),后台可改 label 但 key 勿动。
 * - `video`:卡片/封面显示播放角标(WorkflowGrid / NewProjectDialog)。
 * - `trial`:只对非正式版用户可见(lib/entitlements.ts::canSeeTemplate)。
 */
export const RESERVED_CATEGORY = { video: "video", trial: "trial" } as const;

/** 由分类列表派生 slug→显示名;消费点对未知分类回退显示原 slug(`?? key`)。 */
export function categoryLabelMap(cats: TemplateCategory[]): Record<string, string> {
  return Object.fromEntries(cats.map((c) => [c.key, c.label]));
}

/** 由分类列表派生 slug→排序权重;消费点对未知分类排最后(`?? 99`)。 */
export function categoryOrderMap(cats: TemplateCategory[]): Record<string, number> {
  return Object.fromEntries(cats.map((c, i) => [c.key, c.sort ?? i]));
}
