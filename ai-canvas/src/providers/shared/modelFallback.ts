/**
 * 模型「未配置路由」静默降级 —— 通用机制层。
 *
 * 背景:极境(JiJing)网关把某个模型 SKU 关停后,提交请求会被网关以
 * "模型[xxx]未配置路由" 拒绝。为避免「一关模型整条出图链路就报错」,允许在请求体里
 * 携带一组**降级候选**(`_modelFallbacks`)。提交层(mediaHandler.submitMedia /
 * asyncMediaTask.executeLegacyDirectly)遇到「未配置路由」时,自动改用下一个候选重发,
 * 任务不进 failed、UI 不弹提示(静默降级);其它错误(限流/余额/内容拦截…)不命中,
 * 不会误降级。
 *
 * 分层:本模块只懂「数据 + 识别」,不懂任何具体模型/档位。具体哪个 SKU 降到哪个
 * (含像素 size 换算)由 `generateImage` 决定并写进 `_modelFallbacks`。
 */

import type { AiProxyResponse } from "@/types";

/** 单个降级候选:换 model(必要时连 size 一起换 —— gpt-image-2 档位与像素绑定)。 */
export interface ModelFallback {
  model: string;
  /** 目标档位对应的像素 size(如 "1024x1024");缺省则沿用原 size。 */
  size?: string;
}

/** 请求体里携带降级候选的字段名(下划线前缀=内部控制字段,提交前剥离,绝不外发)。 */
export const MODEL_FALLBACKS_FIELD = "_modelFallbacks";

/**
 * 网关「模型不可用 / 未配置路由」错误的识别特征 —— 覆盖两类网关:
 *   极境(JiJing/喵喵)直连或透传:"模型[xxx]未配置路由"(含截断兜底 "未配置路")
 *   New API 系网关:"…无可用渠道 / 无可用通道"
 */
const ROUTE_UNCONFIGURED_RE = /未配置路|无可用渠道|无可用通道/;

/**
 * 从请求体里剥离 `_modelFallbacks` 控制字段。
 * 返回**不含**该字段的干净 body(用于实际外发)+ 解析出的候选列表。
 * 无该字段时 fallbacks=[],原 body 原样返回(不产生多余拷贝)。
 */
export function splitModelFallbacks(
  body: Record<string, unknown>,
): { body: Record<string, unknown>; fallbacks: ModelFallback[] } {
  const raw = body[MODEL_FALLBACKS_FIELD];
  if (!Array.isArray(raw) || raw.length === 0) {
    return { body, fallbacks: [] };
  }
  const fallbacks = raw.filter(
    (f): f is ModelFallback =>
      !!f && typeof (f as ModelFallback).model === "string",
  );
  const clean = { ...body };
  delete clean[MODEL_FALLBACKS_FIELD];
  return { body: clean, fallbacks };
}

/**
 * 提交响应是否为「模型未配置路由」(可触发降级的信号)。
 * 仅在错误响应(非 2xx)且响应体含特征文案时为真。
 */
export function isRouteUnconfiguredResponse(
  raw: Pick<AiProxyResponse, "status" | "body">,
): boolean {
  return raw.status >= 400 && ROUTE_UNCONFIGURED_RE.test(raw.body);
}

/** 应用一个降级候选到 body:换 model,有 size 则一并换(不改其它字段,如已上传的参考图)。 */
export function applyModelFallback(
  body: Record<string, unknown>,
  fb: ModelFallback,
): Record<string, unknown> {
  return { ...body, model: fb.model, ...(fb.size ? { size: fb.size } : {}) };
}
