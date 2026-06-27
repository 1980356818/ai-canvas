/**
 * 「帮我写」三步的模型调用编排。
 *
 * 复用全仓唯一对话翻译层 `buildChatRequest`（多模态 serialize / 媒体并行上传 / vision 判定 /
 * <upstream_context> 前缀）—— 用一张**合成卡**把 content/_systemPrompt/参考媒体临时改写，
 * 喂给 buildChatRequest，对该共享层零改动、零风险。
 *
 * @素材标签闭环：分析/生成都开 `labelMedia`（buildChatRequest 在每个媒体前插【图N】标记），
 * 标签口径 = computeImageRefSources（与编辑器 @引用一致）。分析后把 elements 与真实素材清单
 * **对账**（丢弃模型瞎编的标签、补齐遗漏），保证 elements 恰好对应连入素材。
 *
 * 走流式 `streamChatToResult`（而非 provider.chat）以规避反代 524；
 * JSON 步骤解析失败自动重试一次（提示词已强约束「只返回 JSON」）。
 */

import type { CanvasCard } from "@/types";
import { buildChatRequest, type BuildChatRequestOptions } from "@/services/generation/buildChatRequest";
import { streamChatToResult } from "@/services/generation/streamChatToResult";
import { modelService } from "@/services/models";
import { computeImageRefSources } from "@/hooks/useImageRefSources";
import { getRefSlotsForChatModel } from "@/config/model-ref-images";
import { parseInsights, parseScript, ScriptParseError } from "@/lib/scriptParse";
import {
  REF_VIDEO_BREAKDOWN_SYSTEM_PROMPT,
  REF_VIDEO_BREAKDOWN_TRIGGER,
  buildAnalyzeUserPrompt,
  buildGenerateSystemPrompt,
  buildGenerateUserPrompt,
  ANALYZE_SYSTEM_PROMPT,
  type MaterialManifestItem,
} from "@/lib/scriptPrompts";
import type {
  MaterialElement,
  ProductInsights,
  ScriptCardData,
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

async function resolveBuilt(card: CanvasCard, buildOpts?: BuildChatRequestOptions) {
  const built = await buildChatRequest(card, buildOpts);
  if (!built.ok) throw new Error(built.reason);
  const provider = modelService.resolveProvider(built.request.model, built.providerId);
  return { request: built.request, provider };
}

/** 跑一次对话并把答案解析成 T；解析失败重试一次（被取消则不重试）。 */
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
  throw lastErr instanceof Error
    ? lastErr
    : new ScriptParseError("模型输出无法解析");
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

/** 把模型产出的 elements 与真实素材清单对账：丢弃越界标签、补齐遗漏、type 以清单为准。 */
export function reconcileElements(
  parsed: MaterialElement[],
  manifest: MaterialManifestItem[],
): MaterialElement[] {
  if (manifest.length === 0) return parsed;
  const byMention = new Map(parsed.map((e) => [e.mention, e]));
  return manifest.map((m) => {
    const e = byMention.get(m.mention);
    return e
      ? { ...e, type: m.type }
      : { mention: m.mention, type: m.type, description: "" };
  });
}

/** ① 分析素材 → 商品洞察。视觉调用：保留连入的图/视频/文本，并带【图N】标签。 */
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

/**
 * ② 生成分镜脚本。视觉调用：**保留带标签的参考素材**（让模型"看着图"按 @标签精准引用），
 * 喂商品洞察 + 配置（+ 可选拆解）。丢弃 directMedia/upstreamTexts，只带 refImages/refVideos 控成本。
 */
export async function runScriptGenerate(
  card: CanvasCard,
  insights: ProductInsights,
  config: ScriptConfig,
  breakdown: string | undefined,
  opts?: RunScriptStepOptions,
): Promise<StoryboardScript> {
  const synth: CanvasCard = {
    ...card,
    data: {
      model: card.data.model,
      provider: card.data.provider,
      refImages: card.data.refImages,
      refVideos: card.data.refVideos,
      content: buildGenerateUserPrompt(insights, config, breakdown),
      _systemPrompt: buildGenerateSystemPrompt(config),
    },
  };
  return runChatJson(synth, parseScript, opts, { labelMedia: true });
}
