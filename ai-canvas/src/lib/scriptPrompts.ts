/**
 * 「帮我写」三段提示词流水线。全部要求**严格 JSON / 纯文本**输出，由 lib/scriptParse 防御解析。
 *
 * 流水线：① 分析素材（视觉，出商品洞察 JSON） → ①.5 参考视频拆解（视觉，出文本，可选）
 *          → ② 生成分镜脚本（文本，出分镜 JSON）。
 */

import {
  type ProductInsights,
  type ScriptConfig,
  businessLabel,
  contentTypeLabel,
  languageLabel,
  shootingStyleLabel,
} from "@/lib/scriptModel";

// ── ① 分析素材（视觉）──
export const ANALYZE_SYSTEM_PROMPT = `你是资深电商短视频策划与商品分析师。用户会提供一组商品素材（图片/视频帧，可能附带文字补充）。请仅依据可见素材客观提炼商品信息，不要臆造素材中不存在的参数、品牌或卖点。

要求：
1. 全部用中文。
2. 严格只返回一个 JSON 对象，不要任何解释文字，不要用 markdown 代码块包裹。
3. JSON 结构如下（字段都必须有；无法判断的数组给空数组、字符串给空串）：
{
  "productName": "商品名称（含品牌/型号，若可见）",
  "category": "商品类目（如：生活电器/便携风扇）",
  "features": ["产品特性，3-6 条，客观描述外观/材质/接口/结构"],
  "sellingPoints": ["核心卖点，3-5 条，面向消费者的利益点"],
  "targetAudience": ["目标人群，2-4 类"],
  "usageScenarios": ["典型使用场景，3-5 个"],
  "materials": [{"ref": "图1", "description": "该素材画面内容的一句话客观描述"}]
}`;

export const ANALYZE_TRIGGER = "请分析以上商品素材，并严格按系统指令返回商品洞察 JSON。";

// ── ①.5 参考视频拆解（视觉，可选，输出纯文本）──
export const REF_VIDEO_BREAKDOWN_SYSTEM_PROMPT = `你是短视频拆解分析师。请观看用户提供的参考视频，拆解其脚本结构，输出一段简洁的中文文字（不是 JSON），包含：整体节奏、镜头序列（景别/运镜）、钩子结构、口播风格。用于指导同类商品的脚本创作。控制在 200 字以内，不要客套话。`;

export const REF_VIDEO_BREAKDOWN_TRIGGER = "请拆解以上参考视频的脚本结构。";

// ── ② 生成分镜脚本（文本）──
export function buildGenerateSystemPrompt(config: ScriptConfig): string {
  return `你是资深短视频导演与脚本编剧，擅长${businessLabel(config.business)}场景的口播带货短视频。请根据用户给出的商品洞察与拍摄配置，产出一支可直接执行的逐秒分镜脚本。

创作约束：
- 业务场景：${businessLabel(config.business)}
- 内容类型：${contentTypeLabel(config.contentType)}
- 拍摄方式：${shootingStyleLabel(config.shootingStyle)}
- 输出语言：${languageLabel(config.language)}（口播旁白与对白用该语言；JSON 字段名保持英文）
- 时长约 30 秒，拆 6-10 个镜头，逐秒覆盖不留空档。
- 口播旁白口语化、开头有钩子；运镜与景别具体可执行；结合商品真实卖点，不夸大、不虚构参数。

严格只返回一个 JSON 对象，不要任何解释文字，不要用 markdown 代码块包裹。结构：
{
  "overview": { "styleKeywords": ["整体风格关键词，2-4 个"], "note": "拍摄方式与整体基调说明" },
  "sceneLighting": { "scene": "拍摄场景", "lighting": "布光与质感" },
  "shots": [
    { "timeRange": "0-3s", "shotType": "景别/角度", "cameraMove": "运镜", "sceneDialogue": "场景与对白/画面动作", "voiceover": "口播旁白", "audioBgm": "音效/BGM 节奏" }
  ]
}`;
}

export function buildGenerateUserPrompt(
  insights: ProductInsights,
  config: ScriptConfig,
  breakdown?: string,
): string {
  const parts: string[] = [];
  parts.push("【商品洞察】");
  if (insights.productName) parts.push(`商品名称：${insights.productName}`);
  if (insights.category) parts.push(`商品类目：${insights.category}`);
  if (insights.features.length) parts.push(`产品特性：${insights.features.join("；")}`);
  if (insights.sellingPoints.length) parts.push(`核心卖点：${insights.sellingPoints.join("；")}`);
  if (insights.targetAudience.length) parts.push(`目标人群：${insights.targetAudience.join("、")}`);
  if (insights.usageScenarios.length) parts.push(`使用场景：${insights.usageScenarios.join("、")}`);

  if (config.notes?.trim()) {
    parts.push("");
    parts.push(`【补充说明】\n${config.notes.trim()}`);
  }
  if (breakdown?.trim()) {
    parts.push("");
    parts.push(`【参考视频拆解】\n${breakdown.trim()}`);
  }
  parts.push("");
  parts.push("请基于以上信息，严格按系统指令产出逐秒分镜脚本 JSON。");
  return parts.join("\n");
}
