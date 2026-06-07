import { lsGet } from "./storage";
import { httpJson } from "./httpAdapter";
import type { TemplateCategory } from "@/config/templateCategories";

function getBaseUrl(): string {
  return lsGet("server_base_url", "http://101.37.80.236");
}

/**
 * 拉服务端模板分组列表(公开端点 GET /api/template-categories,无需 token)。
 *
 * 走 Rust http 桥(`httpJson`)—— ai-canvas 全局规约「前端不直接 fetch 上游」,
 * 详见 src/platform/httpAdapter.ts。`appVersion` 预留(服务端当前不按它过滤分组)。
 * 失败抛错,由 categoryStore 兜底(缓存 / 内置 fallback)。
 */
export async function apiGetCategories(appVersion: string): Promise<TemplateCategory[]> {
  const q = appVersion ? `?appVersion=${encodeURIComponent(appVersion)}` : "";
  const resp = await httpJson({
    url: `${getBaseUrl()}/api/template-categories${q}`,
    method: "GET",
    headers: {},
  });
  let json: { code: number; msg: string; data: TemplateCategory[] };
  try {
    json = JSON.parse(resp.body);
  } catch {
    throw new Error(`分类响应非 JSON (HTTP ${resp.status}): ${resp.body.slice(0, 120)}`);
  }
  if (json.code !== 0) throw new Error(json.msg || "拉取分类失败");
  return json.data ?? [];
}
