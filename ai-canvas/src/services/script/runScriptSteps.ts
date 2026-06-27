/**
 * 「帮我写」三步的模型调用编排。
 *
 * 复用全仓唯一对话翻译层 `buildChatRequest`（多模态 serialize / 媒体并行上传 / vision 判定 /
 * <upstream_context> 前缀）—— 用一张**合成卡**把 content/_systemPrompt/参考媒体临时改写，
 * 喂给 buildChatRequest，对该共享层零改动、零风险。
 *
 * 走流式 `streamChatToResult`（而非 provider.chat）以规避反代 524（见该文件注释）；
 * JSON 步骤解析失败自动重试一次（提示词已强约束「只返回 JSON」）。
 */

import type { CanvasCard } from "@/types";
import { buildChatRequest } from "@/services/generation/buildChatRequest";
import { streamChatToResult } from "@/services/generation/streamChatToResult";
import { modelService } from "@/services/models";
import { parseInsights, parseScript, ScriptParseError } from "@/lib/scriptParse";
import {
  ANALYZE_SYSTEM_PROMPT,
  ANALYZE_TRIGGER,
  REF_VIDEO_BREAKDOWN_SYSTEM_PROMPT,
  REF_VIDEO_BREAKDOWN_TRIGGER,
  buildGenerateSystemPrompt,
  buildGenerateUserPrompt,
} from "@/lib/scriptPrompts";
import type {
  ProductInsights,
  ScriptConfig,
  StoryboardScript,
} from "@/lib/scriptModel";

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

async function resolveBuilt(card: CanvasCard) {
  const built = await buildChatRequest(card);
  if (!built.ok) throw new Error(built.reason);
  const provider = modelService.resolveProvider(built.request.model, built.providerId);
  return { request: built.request, provider };
}

/** 跑一次对话并把答案解析成 T；解析失败重试一次（被取消则不重试）。 */
async function runChatJson<T>(
  card: CanvasCard,
  parse: (raw: string) => T,
  opts?: RunScriptStepOptions,
): Promise<T> {
  const { request, provider } = await resolveBuilt(card);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { content } = await streamChatToResult(provider, request, {
      signal: opts?.signal,
      onText: opts?.onText ? (full) => opts.onText!(full) : undefined,
      onReasoning: opts?.onReasoning,
    });
    try {
      return parse(content);
    } catch (e) {
      lastErr = e;
      if (opts?.signal?.aborted) throw e;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new ScriptParseError("模型输出无法解析");
}

/** ① 分析素材 → 商品洞察。视觉调用：保留连入的图/视频/文本。 */
export async function runScriptAnalyze(
  card: CanvasCard,
  opts?: RunScriptStepOptions,
): Promise<ProductInsights> {
  const synth = synthCard(card, {
    content: ANALYZE_TRIGGER,
    _systemPrompt: ANALYZE_SYSTEM_PROMPT,
    inlineRefs: undefined,
  });
  return runChatJson(synth, parseInsights, opts);
}

/** ①.5 参考视频拆解 → 文本。仅喂连入的视频。 */
export async function runRefVideoBreakdown(
  card: CanvasCard,
  opts?: RunScriptStepOptions,
): Promise<string> {
  const synth = synthCard(card, {
    content: REF_VIDEO_BREAKDOWN_TRIGGER,
    _systemPrompt: REF_VIDEO_BREAKDOWN_SYSTEM_PROMPT,
    refImages: undefined,
    directMedia: undefined,
    inlineRefs: undefined,
  });
  const { request, provider } = await resolveBuilt(synth);
  const { content } = await streamChatToResult(provider, request, {
    signal: opts?.signal,
    onText: opts?.onText ? (full) => opts.onText!(full) : undefined,
    onReasoning: opts?.onReasoning,
  });
  return content.trim();
}

/** ② 生成分镜脚本。纯文本调用：丢弃参考媒体，只喂商品洞察 + 配置（+ 可选拆解）。 */
export async function runScriptGenerate(
  card: CanvasCard,
  insights: ProductInsights,
  config: ScriptConfig,
  breakdown: string | undefined,
  opts?: RunScriptStepOptions,
): Promise<StoryboardScript> {
  // 不 spread card.data：刻意丢弃 refImages/refVideos/directMedia/upstreamTexts → 纯文本更省更稳。
  const synth: CanvasCard = {
    ...card,
    data: {
      model: card.data.model,
      provider: card.data.provider,
      content: buildGenerateUserPrompt(insights, config, breakdown),
      _systemPrompt: buildGenerateSystemPrompt(config),
    },
  };
  return runChatJson(synth, parseScript, opts);
}
