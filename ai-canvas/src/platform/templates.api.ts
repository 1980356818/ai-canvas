import { lsGet } from "./storage";
import { httpJson } from "./httpAdapter";
import type { WorkflowTemplate } from "@/types";

function getBaseUrl(): string {
  return lsGet("server_base_url", "http://101.37.80.236");
}

/**
 * 拉服务端模板列表(公开端点 GET /api/templates,无需 token)。
 *
 * 走 Rust http 桥(`httpJson`)—— ai-canvas 全局规约「前端不直接 fetch 上游」,
 * 详见 src/platform/httpAdapter.ts。`appVersion` 用于服务端版本守卫(过滤掉
 * min_app_version 高于本客户端的模板)。失败抛错,由 templateStore 兜底。
 */
export async function apiGetTemplates(appVersion: string): Promise<WorkflowTemplate[]> {
  const resp = await httpJson({
    url: `${getBaseUrl()}/api/templates?appVersion=${encodeURIComponent(appVersion)}`,
    method: "GET",
    headers: {},
  });
  let json: { code: number; msg: string; data: WorkflowTemplate[] };
  try {
    json = JSON.parse(resp.body);
  } catch {
    throw new Error(`模板响应非 JSON (HTTP ${resp.status}): ${resp.body.slice(0, 120)}`);
  }
  if (json.code !== 0) throw new Error(json.msg || "拉取模板失败");
  return json.data ?? [];
}
