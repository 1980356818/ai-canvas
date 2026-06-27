/**
 * 「帮我写」三段提示词流水线。全部要求**严格 JSON / 纯文本**输出，由 lib/scriptParse 防御解析。
 *
 * 流水线：① 分析素材（视觉，带【图N】标签，出商品洞察 JSON） → ①.5 参考视频拆解（视觉，出文本，可选）
 *          → ② 生成分镜脚本（视觉，看着带标签素材，出分镜 JSON，含 @标签精准引用）。
 *
 * 「@素材标签闭环」：分析/生成都喂带【图N】标签的素材（buildChatRequest labelMedia），
 * 提示词强约束模型只用给定标签引用、多格图精确到区域。标签口径 = computeImageRefSources。
 */

import {
  type MaterialElement,
  type ProductInsights,
  type ScriptConfig,
  businessLabel,
  contentTypeLabel,
  languageLabel,
  shootingStyleLabel,
} from "@/lib/scriptModel";

/** 素材清单项（由服务层从 computeImageRefSources 构建）。 */
export interface MaterialManifestItem {
  mention: string;
  type: "image" | "video" | "audio";
}

function typeLabel(t: "image" | "video" | "audio"): string {
  return t === "video" ? "视频" : t === "audio" ? "音频" : "图片";
}

// ── ① 分析素材（视觉，带标签）──
export const ANALYZE_SYSTEM_PROMPT = `你是资深电商短视频策划与商品分析师。用户会提供一组参考素材（图片/视频帧，可能附带文字补充），**每个素材在画面前已用【图1】【视频1】这样的标签标注**。请仅依据可见素材客观提炼，不要臆造素材中不存在的参数、品牌或卖点。

要求：
1. 全部用中文。
2. 严格只返回一个 JSON 对象，不要任何解释文字，不要用 markdown 代码块包裹。
3. detected：是否存在明确的主推商品（电商带货类为 true；纯生活记录/无明确商品为 false）。
4. elements 必须逐一覆盖每个素材；mention **必须复用给定标签**（如 "图1"/"视频1"，不带 @，不要新造编号）；type 取 image/video/audio；role 描述素材角色（主体参考/动态参考/氛围/细节…）；product_related 标识是否与主推商品相关。
5. JSON 结构如下（字段都必须有；无法判断的数组给空数组、字符串给空串、布尔给 false）：
{
  "detected": true,
  "productName": "商品名称（含品牌/型号，若可见）",
  "category": "商品类目（如：女装-连衣裙）",
  "features": ["产品特性，3-6 条，客观描述外观/材质/结构"],
  "sellingPoints": ["核心卖点，3-5 条，面向消费者的利益点"],
  "targetAudience": ["目标人群，2-4 类"],
  "usageScenarios": ["典型使用场景，3-5 个"],
  "elements": [
    {"mention": "图1", "type": "image", "role": "主体参考", "product_related": true, "description": "该素材画面内容的一句话客观描述"}
  ]
}`;

/** 分析触发词：列出本次素材清单，要求模型在 elements[].mention 复用相同标签。 */
export function buildAnalyzeUserPrompt(manifest: MaterialManifestItem[]): string {
  if (manifest.length === 0) {
    return "请分析以上参考素材，并严格按系统指令返回商品洞察 JSON。";
  }
  const lines = ["本次参考素材（已按标签标注，请逐一分析，elements[].mention 用相同标签）："];
  for (const m of manifest) lines.push(`- ${m.mention}（${typeLabel(m.type)}）`);
  lines.push("");
  lines.push("请严格按系统指令返回商品洞察 JSON。");
  return lines.join("\n");
}

// ── ①.5 参考视频拆解（视觉，可选，输出纯文本）──
export const REF_VIDEO_BREAKDOWN_SYSTEM_PROMPT = `你是短视频拆解分析师。请观看用户提供的参考视频，拆解其脚本结构，输出一段简洁的中文文字（不是 JSON），包含：整体节奏、镜头序列（景别/运镜）、钩子结构、口播风格。用于指导同类商品的脚本创作。控制在 200 字以内，不要客套话。`;

export const REF_VIDEO_BREAKDOWN_TRIGGER = "请拆解以上参考视频的脚本结构。";

// ── ② 生成分镜脚本（视觉，带标签素材）──
export function buildGenerateSystemPrompt(config: ScriptConfig): string {
  const dur = config.durationSeconds || 30;
  // 每镜 4-15 秒(视频模型单段生成范围)→ 镜头数区间由总时长推导。
  const minShots = Math.max(1, Math.ceil(dur / 15));
  const maxShots = Math.max(minShots, Math.floor(dur / 4));
  return `你是资深短视频导演与脚本编剧，擅长${businessLabel(config.business)}场景的口播带货短视频。用户会提供商品洞察、可引用素材清单（每个素材在画面前已用【图1】【视频1】标注）与拍摄配置。请产出一支可直接执行的逐秒分镜脚本。

创作约束：
- 业务场景：${businessLabel(config.business)}
- 内容类型：${contentTypeLabel(config.contentType)}
- 拍摄方式：${shootingStyleLabel(config.shootingStyle)}
- 输出语言：${languageLabel(config.language)}（标题/旁白/对白用该语言；JSON 字段名保持英文）
- 视频总时长约 ${dur} 秒，时间轴从 0 秒连续覆盖到约 ${dur} 秒，不留空档、不重叠。
- 拆成 ${minShots}-${maxShots} 个镜头，**每个镜头时长必须落在 4-15 秒之间**（适配视频模型单段生成）；各镜头时长之和约等于总时长；timeRange 用累计真实区间（如 "0-6s"、"6-13s"）。
- **引用素材时只能使用「可引用素材」里给出的 @标签**（如 @图1、@视频1），不得新造标签或泛泛地说"参考图片"。动态动作优先参考视频类素材（@视频N）。
- 若某素材是多角度拼图/多格图，引用时**精确到区域**（如"参考 @图1 右下半身局部图""参考 @图2 背面图"）。
- 口播旁白口语化、开头有钩子、结尾有行动号召；每镜 tone 标注该句旁白语气（如"轻快闺蜜语气""热烈鼓动"）；结合商品真实卖点，不夸大、不虚构参数。
- scenes 可有多个（不同机位/背景各一条），每条给布景与布光。
- 另给 title（一句话脚本标题）与 summary（一段卖点/转化总结）。

严格只返回一个 JSON 对象，不要任何解释文字，不要用 markdown 代码块包裹。结构：
{
  "title": "一句话脚本标题",
  "summary": "一段卖点与转化逻辑总结",
  "overview": { "styleKeywords": ["整体风格关键词，2-4 个"], "note": "拍摄视角与整体基调（如手持Vlog+闺蜜口吻）" },
  "scenes": [
    { "name": "场景名", "setup": "布景", "lighting": "布光与质感", "mentionRefs": ["图2"] }
  ],
  "shots": [
    { "timeRange": "0-5s", "shotType": "景别/角度", "cameraMove": "运镜", "sceneDialogue": "场景与对白/画面动作（含 @图1/@视频1 精准引用）", "voiceover": "口播旁白", "tone": "旁白语气", "audioBgm": "音效/BGM 节奏" }
  ]
}`;
}

export function buildGenerateUserPrompt(
  insights: ProductInsights,
  config: ScriptConfig,
  breakdown?: string,
): string {
  const parts: string[] = [];

  // 可引用素材清单（带 @标签）—— 模型据此精准引用。
  if (insights.elements.length > 0) {
    parts.push("【可引用素材】");
    for (const el of insights.elements) parts.push(formatElement(el));
    parts.push("");
  }

  parts.push("【商品洞察】");
  if (!insights.detected) parts.push("（未识别到明确主推商品，请按通用叙事创作。）");
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
  parts.push("请基于以上信息，严格按系统指令产出逐秒分镜脚本 JSON，引用素材只用上面给定的 @标签。");
  return parts.join("\n");
}

function formatElement(el: MaterialElement): string {
  const meta = [typeLabel(el.type)];
  if (el.role) meta.push(el.role);
  const desc = el.description ? `：${el.description}` : "";
  return `@${el.mention}（${meta.join("·")}）${desc}`;
}
