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
export interface ProductInsights {
  productName: string;
  category: string;
  features: string[];
  sellingPoints: string[];
  targetAudience: string[];
  usageScenarios: string[];
  /** 逐素材的一句话客观描述（截图里的「素材分析」区）。 */
  materials: { ref: string; description: string }[];
}

export function emptyInsights(): ProductInsights {
  return {
    productName: "",
    category: "",
    features: [],
    sellingPoints: [],
    targetAudience: [],
    usageScenarios: [],
    materials: [],
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
  /** 参考视频拆解开关（仅当连入了视频时有意义）。 */
  useReferenceVideo: boolean;
  notes?: string;
}

export const DEFAULT_SCRIPT_CONFIG: ScriptConfig = {
  business: "ecommerce",
  language: "zh",
  contentType: "auto",
  shootingStyle: "auto",
  useReferenceVideo: false,
  notes: "",
};

// ── 第 3 步：分镜脚本 ──
export interface ShotBreakdown {
  timeRange: string;     // "0-3s"
  shotType: string;      // 景别/角度
  cameraMove: string;    // 运镜
  sceneDialogue: string; // 场景与对白/画面动作
  voiceover: string;     // 口播旁白
  audioBgm: string;      // 音效/BGM 节奏
}

export interface StoryboardScript {
  overview: { styleKeywords: string[]; note: string };
  sceneLighting: { scene: string; lighting: string };
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

function labelOf<T extends string>(opts: { value: T; label: string }[], v: T): string {
  return opts.find((o) => o.value === v)?.label ?? String(v);
}

export const businessLabel = (v: ScriptBusiness) => labelOf(BUSINESS_OPTIONS, v);
export const languageLabel = (v: ScriptLanguage) => labelOf(LANGUAGE_OPTIONS, v);
export const contentTypeLabel = (v: ScriptContentType) => labelOf(CONTENT_TYPE_OPTIONS, v);
export const shootingStyleLabel = (v: ScriptShootingStyle) => labelOf(SHOOTING_STYLE_OPTIONS, v);
