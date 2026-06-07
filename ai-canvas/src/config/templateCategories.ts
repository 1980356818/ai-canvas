/**
 * 模板浏览分类(面向用户)。单一有序口径:驱动首页分类 Tab 顺序、新建弹窗分组、
 * admin 下拉与表格标签。模板的 `category` 字段存这里的 `key`(slug)。
 *
 * 加/改分类 = 改这一处 + 给模板打 category 标签(服务端 admin 可改),桌面端零发版。
 */
export interface TemplateCategory {
  /** 存进模板定义 `category` 字段的稳定 slug。 */
  key: string;
  /** 界面显示名。 */
  label: string;
}

export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  { key: "flat", label: "平面模板" },
  { key: "video", label: "视频模板" },
  { key: "detail", label: "详情页模板" },
  { key: "trial", label: "试用版模板" },
];

/** slug → 显示名;未知分类回退显示原 slug。 */
export const TEMPLATE_CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  TEMPLATE_CATEGORIES.map((c) => [c.key, c.label]),
);

/** 分类排序权重(越小越靠前);未知分类排最后。 */
export const TEMPLATE_CATEGORY_ORDER: Record<string, number> = Object.fromEntries(
  TEMPLATE_CATEGORIES.map((c, i) => [c.key, i]),
);
