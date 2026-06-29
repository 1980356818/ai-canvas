/**
 * 「帮我写」生成编排（Seedance 2.0 单次调用 · Markdown 直出）。
 *
 * 模型一次产出完整分镜报告（产品分析 + 脚本方向 + 分镜表 + 逐镜 Seedance 提示词 +
 * 总提示词 + 声音文案 + 风险检查），以 markdown 写入 data.result —— **不做 JSON 解析**，
 * 创意写作永不"解析失败"。下游 ai_video 按文本读取（与 ai_chat 同构）。
 *
 * @素材标签闭环：开 labelMedia，buildChatRequest 在每张参考图前插【图N】
 *（口径 = computeImageRefSources，与编辑器 @引用一致），提示词据此让模型只用给定
 * 「图N」精准引用、多格图精确到区域。
 *
 * 走流式 streamChatToResult 规避反代 524；用一张合成卡改写 content/_systemPrompt，
 * 对全仓唯一对话翻译层 buildChatRequest 零改动、零风险。
 */

import type { CanvasCard } from "@/types";
import { buildChatRequest, type BuildChatRequestOptions } from "@/services/generation/buildChatRequest";
import { streamChatToResult } from "@/services/generation/streamChatToResult";
import { modelService } from "@/services/models";
import { computeImageRefSources } from "@/hooks/useImageRefSources";
import { getRefSlotsForChatModel } from "@/config/model-ref-images";
import {
  SEEDANCE_SCRIPT_SYSTEM_PROMPT,
  buildSeedanceUserPrompt,
  type MaterialManifestItem,
} from "@/lib/scriptPrompts";
import type { ScriptCardData, ScriptConfig } from "@/lib/scriptModel";

export interface RunScriptStepOptions {
  signal?: AbortSignal;
  /** 流式答案文本回调（向导用于实时预览 / 字数进度）。 */
  onText?: (full: string) => void;
  /** 推理增量（推理模型先思考）。 */
  onReasoning?: (delta: string) => void;
}

/** 合成一张临时卡：保留真实 id（让 buildChatRequest 读到真实连线），改写提示词/媒体。 */
function synthCard(card: CanvasCard, dataOverride: Record<string, unknown>): CanvasCard {
  return { ...card, data: { ...card.data, ...dataOverride } };
}

async function resolveBuilt(card: CanvasCard, buildOpts?: BuildChatRequestOptions) {
  const built = await buildChatRequest(card, buildOpts);
  if (!built.ok) throw new Error(built.reason);
  const provider = modelService.resolveProvider(built.request.model, built.providerId);
  return { request: built.request, provider };
}

/** 从连入素材构建标签清单（与 buildChatRequest labelMedia 同一份 computeImageRefSources 口径）。 */
export function buildMaterialManifest(card: CanvasCard): MaterialManifestItem[] {
  const data = card.data as ScriptCardData;
  const model = (data.model ?? "").trim();
  const refSlots = getRefSlotsForChatModel(model);
  const options = computeImageRefSources(
    card.id,
    refSlots,
    data.refImages,
    undefined,
    data.refVideos,
  );
  return options
    .filter((o) => o.category === "slot" || o.category === "upstream" || o.category === "video")
    .map((o) => ({ mention: o.label, type: o.category === "video" ? "video" : "image" }));
}

/**
 * 生成分镜脚本：单次视觉调用，带【图N】标签素材，喂业务/语言/内容类型/时长/补充配置。
 * 返回模型原文 markdown —— 不解析、不序列化，原文即真相直接写 data.result。
 */
export async function runScriptSeedance(
  card: CanvasCard,
  config: ScriptConfig,
  opts?: RunScriptStepOptions,
): Promise<string> {
  const manifest = buildMaterialManifest(card);
  const synth = synthCard(card, {
    content: buildSeedanceUserPrompt(config, manifest),
    _systemPrompt: SEEDANCE_SCRIPT_SYSTEM_PROMPT,
    inlineRefs: undefined,
  });
  const { request, provider } = await resolveBuilt(synth, { labelMedia: true });
  const { content } = await streamChatToResult(provider, request, {
    signal: opts?.signal,
    onText: opts?.onText ? (full) => opts.onText!(full) : undefined,
    onReasoning: opts?.onReasoning,
  });
  return content.trim();
}
