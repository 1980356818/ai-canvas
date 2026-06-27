/**
 * 防御式解析模型输出的 JSON（商品洞察 / 分镜脚本）。
 *
 * 模型常把 JSON 包在 ```json 代码块里、或前后带解释文字、或字段类型不稳（字符串当数组）。
 * 这里统一：抽取首个平衡 JSON 块 → JSON.parse → 逐字段强制 coerce + 兜底。
 * 解析不出有效内容抛 `ScriptParseError`，由服务层重试一次再上抛。
 */

import type { ProductInsights, StoryboardScript, ShotBreakdown } from "@/lib/scriptModel";

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

function str(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function arr(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === "string" ? x.trim() : str(x)))
      .filter((x) => x.length > 0);
  }
  const single = str(v);
  return single ? [single] : [];
}

function materialArr(v: unknown): { ref: string; description: string }[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((item, i) => {
      if (typeof item === "string") return { ref: `素材${i + 1}`, description: item.trim() };
      const o = (item ?? {}) as Record<string, unknown>;
      return { ref: str(o.ref) || `素材${i + 1}`, description: str(o.description) };
    })
    .filter((m) => m.description.length > 0);
}

export function parseInsights(raw: string): ProductInsights {
  const o = parseJsonLoose(raw);
  const insights: ProductInsights = {
    productName: str(o.productName),
    category: str(o.category),
    features: arr(o.features),
    sellingPoints: arr(o.sellingPoints),
    targetAudience: arr(o.targetAudience),
    usageScenarios: arr(o.usageScenarios),
    materials: materialArr(o.materials),
  };
  // 全空 = 基本是垃圾输出，触发重试。
  const hasAny =
    insights.productName ||
    insights.category ||
    insights.features.length ||
    insights.sellingPoints.length;
  if (!hasAny) throw new ScriptParseError("商品洞察内容为空");
  return insights;
}

function shotFrom(item: unknown): ShotBreakdown {
  const o = (item ?? {}) as Record<string, unknown>;
  return {
    timeRange: str(o.timeRange ?? o.time ?? o.range),
    shotType: str(o.shotType ?? o.shot ?? o.framing),
    cameraMove: str(o.cameraMove ?? o.camera ?? o.movement),
    sceneDialogue: str(o.sceneDialogue ?? o.scene ?? o.dialogue ?? o.action),
    voiceover: str(o.voiceover ?? o.narration ?? o.voice),
    audioBgm: str(o.audioBgm ?? o.audio ?? o.bgm ?? o.sound),
  };
}

export function parseScript(raw: string): StoryboardScript {
  const o = parseJsonLoose(raw);
  const overview = (o.overview ?? {}) as Record<string, unknown>;
  const scene = (o.sceneLighting ?? o.scene ?? {}) as Record<string, unknown>;
  const shotsRaw = Array.isArray(o.shots) ? o.shots : [];

  const shots = shotsRaw
    .map(shotFrom)
    .filter((s) => s.timeRange || s.shotType || s.sceneDialogue || s.voiceover);

  if (shots.length === 0) throw new ScriptParseError("分镜脚本缺少有效镜头");

  return {
    overview: {
      styleKeywords: arr(overview.styleKeywords ?? overview.keywords),
      note: str(overview.note ?? overview.description),
    },
    sceneLighting: {
      scene: str(scene.scene ?? scene.location),
      lighting: str(scene.lighting ?? scene.light),
    },
    shots,
  };
}
