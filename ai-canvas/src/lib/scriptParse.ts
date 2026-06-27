/**
 * 防御式解析模型输出的 JSON（商品洞察 / 分镜脚本）。
 *
 * 模型常把 JSON 包在 ```json 代码块里、或前后带解释文字、或字段类型不稳（字符串当数组）。
 * 这里统一：抽取首个平衡 JSON 块 → JSON.parse → 交给 scriptModel 的 coerce（强制 coerce + 迁移老结构）。
 * 解析不出有效内容抛 `ScriptParseError`，由服务层重试一次再上抛。
 *
 * coerce 逻辑（elements/scenes 迁移、@标签抽取）集中在 scriptModel，供解析与持久化恢复共用单一口径。
 */

import {
  type ProductInsights,
  type StoryboardScript,
  coerceInsights,
  coerceScript,
} from "@/lib/scriptModel";

export class ScriptParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptParseError";
  }
}

/**
 * 从可能含 markdown / 解释文字的原文里抽出首个平衡的 JSON 对象/数组字符串。
 * 扫描时跳过字符串字面量内的括号，避免被引号里的 `{` 误导。
 */
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

export function parseInsights(raw: string): ProductInsights {
  const insights = coerceInsights(parseJsonLoose(raw));
  // 全空 = 基本是垃圾输出，触发重试。
  const hasAny =
    insights.productName ||
    insights.category ||
    insights.features.length ||
    insights.sellingPoints.length ||
    insights.elements.length;
  if (!hasAny) throw new ScriptParseError("商品洞察内容为空");
  return insights;
}

export function parseScript(raw: string): StoryboardScript {
  const script = coerceScript(parseJsonLoose(raw));
  if (script.shots.length === 0) throw new ScriptParseError("分镜脚本缺少有效镜头");
  return script;
}

// ── 校验门（非阻断）：返回 warnings[]，由向导黄条提示，用户可选「重新生成」──

/** 解析 "0-6s" / "6-13" → {start,end}（秒）；解析不出返回 null。 */
function parseTimeRange(s: string): { start: number; end: number } | null {
  const m = s.match(/(\d+(?:\.\d+)?)\s*[-~—]\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

/**
 * 校验脚本质量（不抛错，返回提示列表）：
 *  - 每镜时长落在 4-15s（视频模型单段范围）；
 *  - 时间轴连续不断裂；
 *  - 引用的 @标签必须属于素材清单（白名单）。
 */
export function validateScriptWarnings(
  script: StoryboardScript,
  insights?: ProductInsights | null,
): string[] {
  const warnings: string[] = [];

  let prevEnd: number | null = null;
  script.shots.forEach((s, i) => {
    const span = parseTimeRange(s.timeRange);
    if (!span) return;
    const dur = Math.round((span.end - span.start) * 10) / 10;
    if (dur < 4 || dur > 15) {
      warnings.push(`镜头 ${i + 1}（${s.timeRange}）时长约 ${dur}s，超出 4–15s 区间`);
    }
    if (prevEnd !== null && Math.abs(span.start - prevEnd) > 0.05) {
      warnings.push(`镜头 ${i + 1}（${s.timeRange}）时间轴与上一镜不连续`);
    }
    prevEnd = span.end;
  });

  const allowed = new Set((insights?.elements ?? []).map((e) => e.mention));
  if (allowed.size > 0) {
    const used = new Set<string>();
    script.shots.forEach((s) => (s.mentionRefs ?? []).forEach((m) => used.add(m)));
    script.scenes.forEach((sc) => (sc.mentionRefs ?? []).forEach((m) => used.add(m)));
    const bad = [...used].filter((m) => !allowed.has(m));
    if (bad.length > 0) {
      warnings.push(`脚本引用了不在素材清单中的标签：${bad.map((b) => "@" + b).join("、")}`);
    }
  }

  return warnings;
}
