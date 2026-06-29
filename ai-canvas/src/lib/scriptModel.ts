/**
 * 「帮我写」分镜脚本节点（ai_script）的纯数据模型 + 配置选项。
 *
 * 放在 lib 层（而非 features/script）以避免 features → services → lib → features 的循环：
 * prompts / 服务层 / UI 都从这里取类型与选项。无运行时副作用。
 *
 * 该卡的 I/O 与 ai_chat 同构（见 lib/dataFlow.ts 的镜像分支）：最终分镜脚本写入
 * `data.result`（markdown 文本，模型原文直出），下游视频/图片卡按文本读取。
 */

import type { RefImageEntry } from "@/config/model-ref-images";

// ── 脚本配置（用户输入：业务/语言/内容类型/时长/补充说明）──
export type ScriptBusiness = "ecommerce" | "local_store" | "on_site" | "education";
export type ScriptLanguage = "auto" | "zh" | "en" | "ja" | "de" | "fr";
export type ScriptContentType = "auto" | "selling" | "planting" | "hook" | "drama" | "vlog";

export interface ScriptConfig {
  business: ScriptBusiness;
  language: ScriptLanguage;
  contentType: ScriptContentType;
  /** 目标视频总时长（秒）。Seedance 按 15/30/45/60 档拆镜。 */
  durationSeconds: number;
  /** 补充说明（卖点/场景/结尾文案等，可空）。 */
  notes?: string;
}

export const DEFAULT_SCRIPT_CONFIG: ScriptConfig = {
  business: "ecommerce",
  language: "zh",
  contentType: "auto",
  durationSeconds: 30,
  notes: "",
};

// ── 卡片 data 形状（card.data 的类型化视图）──
export interface ScriptCardData {
  // 与 ai_chat 同构的 I/O 底座（dataFlow 注入/抽取直接复用）
  model?: string;
  provider?: string;
  refImages?: Record<string, RefImageEntry>;
  refVideos?: { url: string; sourceCardId?: string }[];
  directMedia?: { url: string; displayUrl?: string; kind: "image" | "video" }[];
  upstreamTexts?: Record<string, string>;
  /** 最终分镜脚本（markdown，模型原文）—— 下游唯一真相。 */
  result?: string;

  // 帮我写专属态（落库，支持关弹窗后恢复）
  config?: ScriptConfig;
  _wizardStep?: number;
  _resultStale?: boolean;
  /** 生成时连入素材的指纹（url 集合）；与当前不一致 → 提示「素材已变化，建议重新生成」。 */
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

// 目标视频总时长（秒）。Seedance 据此拆镜（每镜 2-8 秒，按时长档自动确定镜头数）。
export const DURATION_OPTIONS: { value: number; label: string }[] = [
  { value: 15, label: "15 秒" },
  { value: 30, label: "30 秒" },
  { value: 45, label: "45 秒" },
  { value: 60, label: "60 秒" },
];

function labelOf<T extends string | number>(opts: { value: T; label: string }[], v: T): string {
  return opts.find((o) => o.value === v)?.label ?? String(v);
}

export const businessLabel = (v: ScriptBusiness) => labelOf(BUSINESS_OPTIONS, v);
export const languageLabel = (v: ScriptLanguage) => labelOf(LANGUAGE_OPTIONS, v);
export const contentTypeLabel = (v: ScriptContentType) => labelOf(CONTENT_TYPE_OPTIONS, v);

// ── 素材标签工具（markdown 里 @图N 的归一与抽取，供 @标签闭环/下游引用用）──

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
