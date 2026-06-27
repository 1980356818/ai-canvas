/**
 * 「帮我写」分镜脚本节点（ai_script）的纯数据模型 + 配置选项。
 *
 * 放在 lib 层（而非 features/script）以避免 features → services → lib → features 的循环：
 * prompts / parse / serialize / 服务层 / UI 都从这里取类型与选项。无运行时副作用。
 *
 * 该卡的 I/O 与 ai_chat 同构（见 lib/dataFlow.ts 的镜像分支）：最终分镜脚本写入
 * `data.result`（markdown 文本），下游视频/图片卡按文本读取。
 */

import type { RefImageEntry } from "@/config/model-ref-images";

// ── 第 1 步：商品洞察（视觉分析产物，可在向导中编辑）──

/**
 * 单个参考素材的分析结果。`mention` 是与画布一致的稳定标签（图1/视频1/音频1，
 * 来自 computeImageRefSources 单一真相），是「@素材绑定闭环」的命脉：分析按它产出、
 * 生成按它精准引用、序列化原样透传。
 */
export interface MaterialElement {
  /** "图1" / "视频1" / "音频1"（不含 @）。 */
  mention: string;
  type: "image" | "video" | "audio";
  /** 模型对该素材画面内容的一句话客观描述。 */
  description: string;
  /** 素材角色，如「主体参考」「动态参考」「氛围」「细节」。 */
  role?: string;
  /** 是否与主推商品直接相关。 */
  productRelated?: boolean;
  /** 来源卡片 id，便于下游溯源/转发（P3 留口）。 */
  sourceCardId?: string;
}

export interface ProductInsights {
  /** 是否检测到明确的主推商品；false 时走通用叙事（非电商/无明确商品）。 */
  detected: boolean;
  productName: string;
  category: string;
  features: string[];
  sellingPoints: string[];
  targetAudience: string[];
  usageScenarios: string[];
  /** 逐素材分析（截图里的「素材分析」区），带稳定 @标签。 */
  elements: MaterialElement[];
}

export function emptyInsights(): ProductInsights {
  return {
    detected: false,
    productName: "",
    category: "",
    features: [],
    sellingPoints: [],
    targetAudience: [],
    usageScenarios: [],
    elements: [],
  };
}

// ── 第 2 步：脚本配置 ──
export type ScriptBusiness = "ecommerce" | "local_store" | "on_site" | "education";
export type ScriptLanguage = "auto" | "zh" | "en" | "ja" | "de" | "fr";
export type ScriptContentType = "auto" | "selling" | "planting" | "hook" | "drama" | "vlog";
export type ScriptShootingStyle =
  | "auto"
  | "desktop_unbox"
  | "real_person"
  | "one_take"
  | "motion"
  | "brand_tvc";

export interface ScriptConfig {
  business: ScriptBusiness;
  language: ScriptLanguage;
  contentType: ScriptContentType;
  shootingStyle: ScriptShootingStyle;
  /** 目标视频总时长（秒）。脚本据此拆镜,每镜自动控制在 4-15 秒(适配视频模型单段生成范围)。 */
  durationSeconds: number;
  /** 参考视频拆解开关（仅当连入了视频时有意义）。 */
  useReferenceVideo: boolean;
  notes?: string;
}

export const DEFAULT_SCRIPT_CONFIG: ScriptConfig = {
  business: "ecommerce",
  language: "zh",
  contentType: "auto",
  shootingStyle: "auto",
  durationSeconds: 30,
  useReferenceVideo: false,
  notes: "",
};

// ── 第 3 步：分镜脚本 ──

/** 一个拍摄场景 + 其布光（实测 da-ai 场景与光线是多个）。 */
export interface SceneSetup {
  name: string;     // "暖调衣帽间" / "无影白背景"
  setup: string;    // 布景
  lighting: string; // 布光与质感
  /** 该场景关联到的素材标签（图1/视频1…），驱动 UI 高亮。 */
  mentionRefs?: string[];
}

export interface ShotBreakdown {
  timeRange: string;     // "0-3s"
  shotType: string;      // 景别/角度
  cameraMove: string;    // 运镜
  sceneDialogue: string; // 场景与对白/画面动作（含 @图1/@视频1 引用，可精确到区域）
  voiceover: string;     // 口播旁白
  tone?: string;         // 旁白语气标注（"轻快闺蜜语气"/"热烈鼓动"）
  audioBgm: string;      // 音效/BGM 节奏
  /** 该镜引用到的素材标签（解析时从 sceneDialogue/voiceover 抽取回填）。 */
  mentionRefs?: string[];
}

export interface StoryboardScript {
  title: string;
  summary: string;
  overview: { styleKeywords: string[]; note: string };
  scenes: SceneSetup[];
  shots: ShotBreakdown[];
}

// ── 卡片 data 形状（card.data 的类型化视图）──
export interface ScriptCardData {
  // 与 ai_chat 同构的 I/O 底座（dataFlow 注入/抽取直接复用）
  model?: string;
  provider?: string;
  refImages?: Record<string, RefImageEntry>;
  refVideos?: { url: string; sourceCardId?: string }[];
  directMedia?: { url: string; displayUrl?: string; kind: "image" | "video" }[];
  upstreamTexts?: Record<string, string>;
  /** 最终分镜脚本（markdown）—— 下游唯一真相。 */
  result?: string;

  // 帮我写专属态（逐步落库，支持关弹窗后恢复）
  insights?: ProductInsights;
  config?: ScriptConfig;
  script?: StoryboardScript;
  refVideoBreakdown?: string;
  _wizardStep?: number;
  _analyzedAt?: string;
  _resultStale?: boolean;
  /** 分析时连入素材的指纹（url 集合）；与当前不一致 → 提示「素材已变化，建议重新分析」。 */
  _analyzedFingerprint?: string;
  /** 上次某步失败的轻量记录，关弹窗重开时提示可重试。 */
  _lastStepError?: { step: number; message: string };
}

// ── 配置选项（prompts 与 UI 共用单一真相，对齐第三方截图）──
export const BUSINESS_OPTIONS: { value: ScriptBusiness; label: string }[] = [
  { value: "ecommerce", label: "电商带货" },
  { value: "local_store", label: "同城到店" },
  { value: "on_site", label: "上门服务" },
  { value: "education", label: "教育培训" },
];

export const LANGUAGE_OPTIONS: { value: ScriptLanguage; label: string }[] = [
  { value: "auto", label: "不限" },
  { value: "zh", label: "中文" },
  { value: "en", label: "英文" },
  { value: "ja", label: "日文" },
  { value: "de", label: "德文" },
  { value: "fr", label: "法文" },
];

export const CONTENT_TYPE_OPTIONS: { value: ScriptContentType; label: string }[] = [
  { value: "auto", label: "智能匹配" },
  { value: "selling", label: "带货" },
  { value: "planting", label: "种草" },
  { value: "hook", label: "卖点钩子" },
  { value: "drama", label: "剧情演绎" },
  { value: "vlog", label: "生活记录" },
];

export const SHOOTING_STYLE_OPTIONS: { value: ScriptShootingStyle; label: string }[] = [
  { value: "auto", label: "智能匹配" },
  { value: "desktop_unbox", label: "桌拍开箱" },
  { value: "real_person", label: "真人口播" },
  { value: "one_take", label: "一镜到底" },
  { value: "motion", label: "运动跟拍" },
  { value: "brand_tvc", label: "品牌TVC" },
];

// 目标视频总时长（秒）。脚本拆出的每个镜头会落在 4-15 秒, 适配视频模型单段生成范围。
export const DURATION_OPTIONS: { value: number; label: string }[] = [
  { value: 15, label: "15 秒" },
  { value: 30, label: "30 秒" },
  { value: 45, label: "45 秒" },
  { value: 60, label: "60 秒" },
];

function labelOf<T extends string>(opts: { value: T; label: string }[], v: T): string {
  return opts.find((o) => o.value === v)?.label ?? String(v);
}

export const businessLabel = (v: ScriptBusiness) => labelOf(BUSINESS_OPTIONS, v);
export const languageLabel = (v: ScriptLanguage) => labelOf(LANGUAGE_OPTIONS, v);
export const contentTypeLabel = (v: ScriptContentType) => labelOf(CONTENT_TYPE_OPTIONS, v);
export const shootingStyleLabel = (v: ScriptShootingStyle) => labelOf(SHOOTING_STYLE_OPTIONS, v);

// ── 纯函数：强制类型 + 迁移老结构（无运行时副作用、不抛错）──
// 分析/生成解析（scriptParse）与持久化恢复（向导 load）共用，是 elements/scenes 的唯一 coerce 口径。

function str(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function arr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => str(x)).filter((x) => x.length > 0);
  const single = str(v);
  return single ? [single] : [];
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** 归一化素材标签：去掉前导 @、把竞品的「图片N」统一成画布口径「图N」。 */
export function normalizeMention(raw: string): string {
  return raw.trim().replace(/^@+/, "").replace(/^图片(?=\d)/, "图");
}

/** 从一段文字里抽出被引用的素材标签（@图1 / @视频1 / @音频1），去重保序。 */
export function extractMentions(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /@(图片|图|视频|音频)\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const label = normalizeMention(`${m[1]}${m[2]}`);
    if (!seen.has(label)) {
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}

function mentionType(mention: string): MaterialElement["type"] {
  if (mention.startsWith("视频")) return "video";
  if (mention.startsWith("音频")) return "audio";
  return "image";
}

function coerceElements(v: unknown): MaterialElement[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((item, i): MaterialElement => {
      if (typeof item === "string") {
        return { mention: `图${i + 1}`, type: "image", description: item.trim() };
      }
      const o = obj(item);
      // 兼容老结构 materials:[{ref,description}] 与新结构 elements:[{mention,...}]
      const mention = normalizeMention(str(o.mention) || str(o.ref)) || `图${i + 1}`;
      const typeRaw = str(o.type);
      const type =
        typeRaw === "video" || typeRaw === "audio" || typeRaw === "image"
          ? (typeRaw as MaterialElement["type"])
          : mentionType(mention);
      const role = str(o.role);
      const related = o.product_related ?? o.productRelated;
      return {
        mention,
        type,
        description: str(o.description) || str(o.desc),
        ...(role ? { role } : {}),
        ...(typeof related === "boolean" ? { productRelated: related } : {}),
        ...(str(o.sourceCardId) ? { sourceCardId: str(o.sourceCardId) } : {}),
      };
    })
    .filter((e) => e.description.length > 0 || e.mention.length > 0);
}

/** 模型输出 / 持久化对象 → ProductInsights（best-effort，迁移 materials→elements）。 */
export function coerceInsights(o: Record<string, unknown>): ProductInsights {
  const elements = coerceElements(o.elements ?? o.materials);
  const productName = str(o.productName);
  const detected = typeof o.detected === "boolean" ? o.detected : productName.length > 0;
  return {
    detected,
    productName,
    category: str(o.category),
    features: arr(o.features),
    sellingPoints: arr(o.sellingPoints),
    targetAudience: arr(o.targetAudience),
    usageScenarios: arr(o.usageScenarios),
    elements,
  };
}

function coerceScenes(v: unknown): SceneSetup[] {
  const one = (o: Record<string, unknown>): SceneSetup => {
    const setup = str(o.setup) || str(o.scene) || str(o.location);
    const lighting = str(o.lighting) || str(o.light);
    const refs = arr(o.mentionRefs).map(normalizeMention);
    const fromText = extractMentions(`${str(o.name)} ${setup}`);
    const mentionRefs = Array.from(new Set([...refs, ...fromText]));
    return { name: str(o.name), setup, lighting, ...(mentionRefs.length ? { mentionRefs } : {}) };
  };
  if (Array.isArray(v)) {
    return v.map((x) => one(obj(x))).filter((s) => s.name || s.setup || s.lighting);
  }
  // 老结构 sceneLighting 单对象 → 单场景。
  const single = one(obj(v));
  return single.setup || single.lighting ? [single] : [];
}

function coerceShots(v: unknown): ShotBreakdown[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((item): ShotBreakdown => {
      const o = obj(item);
      const sceneDialogue = str(o.sceneDialogue) || str(o.scene) || str(o.dialogue) || str(o.action);
      const voiceover = str(o.voiceover) || str(o.narration) || str(o.voice);
      const tone = str(o.tone);
      const mentionRefs = Array.from(
        new Set([...extractMentions(sceneDialogue), ...extractMentions(voiceover)]),
      );
      return {
        timeRange: str(o.timeRange) || str(o.time) || str(o.range),
        shotType: str(o.shotType) || str(o.shot) || str(o.framing),
        cameraMove: str(o.cameraMove) || str(o.camera) || str(o.movement),
        sceneDialogue,
        voiceover,
        ...(tone ? { tone } : {}),
        audioBgm: str(o.audioBgm) || str(o.audio) || str(o.bgm) || str(o.sound),
        ...(mentionRefs.length ? { mentionRefs } : {}),
      };
    })
    .filter((s) => s.timeRange || s.shotType || s.sceneDialogue || s.voiceover);
}

/** 模型输出 / 持久化对象 → StoryboardScript（best-effort，迁移 sceneLighting→scenes）。 */
export function coerceScript(o: Record<string, unknown>): StoryboardScript {
  const overview = obj(o.overview);
  return {
    title: str(o.title),
    summary: str(o.summary),
    overview: {
      styleKeywords: arr(overview.styleKeywords ?? overview.keywords),
      note: str(overview.note) || str(overview.description),
    },
    scenes: coerceScenes(o.scenes ?? o.sceneLighting ?? o.scene),
    shots: coerceShots(o.shots),
  };
}

/** 持久化的 insights（可能是老结构或 undefined）→ 规范结构；无有效内容返回 null。 */
export function normalizeInsights(v: unknown): ProductInsights | null {
  if (!v || typeof v !== "object") return null;
  const ins = coerceInsights(v as Record<string, unknown>);
  const has = ins.productName || ins.elements.length || ins.features.length || ins.sellingPoints.length;
  return has ? ins : null;
}

/** 持久化的 script（可能是老结构或 undefined）→ 规范结构；无有效镜头返回 null。 */
export function normalizeScript(v: unknown): StoryboardScript | null {
  if (!v || typeof v !== "object") return null;
  const sc = coerceScript(v as Record<string, unknown>);
  return sc.shots.length ? sc : null;
}
