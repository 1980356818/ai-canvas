/**
 * 防御式解析「分析素材」步的模型 JSON → ProductInsights。
 *
 * 模型常把 JSON 包在 ```json 里或前后带解释文字。这里抽首个平衡 JSON 块 → JSON.parse →
 * 交给 scriptModel.coerceInsights(强制 coerce)。解析不出有效内容抛 ScriptParseError,
 * 服务层重试一次再上抛。
 *
 * 注:仅「分析」步走 JSON(短、稳);脚本生成步是 Markdown 直出,不经此解析。
 */

import { type ProductInsights, coerceInsights } from "@/lib/scriptModel";

export class ScriptParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptParseError";
  }
}

/** 从可能含 markdown / 解释文字的原文里抽出首个平衡的 JSON 对象/数组字符串。 */
export function extractJsonBlock(raw: string): string | null {
  if (!raw) return null;
  let s = raw.trim();

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();

  const firstObj = s.indexOf("{");
  const firstArr = s.indexOf("[");
  if (firstObj === -1 && firstArr === -1) return null;

  let start: number;
  let openCh: string;
  let closeCh: string;
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
    start = firstArr;
    openCh = "[";
    closeCh = "]";
  } else {
    start = firstObj;
    openCh = "{";
    closeCh = "}";
  }

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function parseJsonLoose(raw: string): Record<string, unknown> {
  const block = extractJsonBlock(raw);
  if (!block) throw new ScriptParseError("未在模型输出中找到 JSON");
  try {
    const v = JSON.parse(block) as unknown;
    if (!v || typeof v !== "object") throw new ScriptParseError("JSON 顶层不是对象");
    return v as Record<string, unknown>;
  } catch (e) {
    if (e instanceof ScriptParseError) throw e;
    throw new ScriptParseError("JSON 解析失败");
  }
}

/** 解析商品洞察;全空视为垃圾输出,抛错触发重试。 */
export function parseInsights(raw: string): ProductInsights {
  const insights = coerceInsights(parseJsonLoose(raw));
  const hasAny =
    insights.productName ||
    insights.category ||
    insights.features.length ||
    insights.sellingPoints.length ||
    insights.elements.length;
  if (!hasAny) throw new ScriptParseError("商品洞察内容为空");
  return insights;
}
