/**
 * 「帮我写」模型调用编排:
 *   ① 分析素材(视觉,带【图N】标签,出商品洞察 JSON,供向导编辑校对) —— runScriptAnalyze
 *   ② 生成分镜脚本(视觉,单次 Markdown 直出,带"已确认洞察")     —— runScriptSeedance
 *
 * 复用全仓唯一对话翻译层 buildChatRequest(合成卡临时改写 content/_systemPrompt,零改共享层);
 * 开 labelMedia 在每张参考图前插【图N】(口径 = computeImageRefSources)。走流式 streamChatToResult
 * 规避反代 524。分析步是短 JSON(解析失败自动重试一次);生成步是 markdown 原文(不解析,创意永不失败)。
 */

import type { CanvasCard } from "@/types";
import { buildChatRequest, type BuildChatRequestOptions } from "@/services/generation/buildChatRequest";
import { streamChatToResult } from "@/services/generation/streamChatToResult";
import { modelService } from "@/services/models";
import { computeImageRefSources } from "@/hooks/useImageRefSources";
import { getRefSlotsForChatModel } from "@/config/model-ref-images";
import { parseInsights, ScriptParseError } from "@/lib/scriptParse";
import {
  SEEDANCE_SCRIPT_SYSTEM_PROMPT,
  ANALYZE_SYSTEM_PROMPT,
  buildSeedanceUserPrompt,
  buildAnalyzeUserPrompt,
  type MaterialManifestItem,
} from "@/lib/scriptPrompts";
import type { MaterialElement, ProductInsights, ScriptCardData, ScriptConfig } from "@/lib/scriptModel";

export interface RunScriptStepOptions {
  signal?: AbortSignal;
  /** 流式答案文本回调(向导用于实时预览 / 字数进度)。 */
  onText?: (full: string) => void;
  /** 推理增量(推理模型先思考)。 */
  onReasoning?: (delta: string) => void;
}

/** 合成一张临时卡:保留真实 id(让 buildChatRequest 读到真实连线),改写提示词/媒体。 */
function synthCard(card: CanvasCard, dataOverride: Record<string, unknown>): CanvasCard {
  return { ...card, data: { ...card.data, ...dataOverride } };
}

async function resolveBuilt(card: CanvasCard, buildOpts?: BuildChatRequestOptions) {
  const built = await buildChatRequest(card, buildOpts);
  if (!built.ok) throw new Error(built.reason);
  const provider = modelService.resolveProvider(built.request.model, built.providerId);
  return { request: built.request, provider };
}

/** 从连入素材构建标签清单(与 buildChatRequest labelMedia 同一份 computeImageRefSources 口径)。 */
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

/** 跑一次对话并把答案解析成 T;解析失败重试一次(被取消则不重试)。 */
async function runChatJson<T>(
  card: CanvasCard,
  parse: (raw: string) => T,
  opts?: RunScriptStepOptions,
  buildOpts?: BuildChatRequestOptions,
): Promise<T> {
  const { request, provider } = await resolveBuilt(card, buildOpts);
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
  throw lastErr instanceof Error ? lastErr : new ScriptParseError("模型输出无法解析");
}

/** 把模型产出的 elements 与真实素材清单对账:丢弃越界标签、补齐遗漏、type 以清单为准。 */
export function reconcileElements(
  parsed: MaterialElement[],
  manifest: MaterialManifestItem[],
): MaterialElement[] {
  if (manifest.length === 0) return parsed;
  const byMention = new Map(parsed.map((e) => [e.mention, e]));
  return manifest.map((m) => {
    const e = byMention.get(m.mention);
    return e ? { ...e, type: m.type } : { mention: m.mention, type: m.type, description: "" };
  });
}

/** ① 分析素材 → 商品洞察。视觉调用:保留连入的图/视频/文本,并带【图N】标签。 */
export async function runScriptAnalyze(
  card: CanvasCard,
  opts?: RunScriptStepOptions,
): Promise<ProductInsights> {
  const manifest = buildMaterialManifest(card);
  const synth = synthCard(card, {
    content: buildAnalyzeUserPrompt(manifest),
    _systemPrompt: ANALYZE_SYSTEM_PROMPT,
    inlineRefs: undefined,
  });
  const insights = await runChatJson(synth, parseInsights, opts, { labelMedia: true });
  insights.elements = reconcileElements(insights.elements, manifest);
  return insights;
}

/**
 * ② 生成分镜脚本:单次视觉调用,带【图N】标签素材 + 已确认商品洞察(若有,以其为准),
 * 喂业务/语言/内容类型/时长/补充配置。返回模型原文 markdown —— 不解析、不序列化,直接写 data.result。
 */
export async function runScriptSeedance(
  card: CanvasCard,
  config: ScriptConfig,
  insights?: ProductInsights,
  opts?: RunScriptStepOptions,
): Promise<string> {
  const manifest = buildMaterialManifest(card);
  const synth = synthCard(card, {
    content: buildSeedanceUserPrompt(config, manifest, insights),
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
