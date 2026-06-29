/**
 * 从「帮我写」生成的 markdown 脚本里抽出逐镜信息,驱动 P2「一键铺下游 ai_video 生产线」。
 *
 * 真相仍是 markdown(data.result);本模块是 **best-effort 派生索引**——抽不到就返回空数组,
 * 绝不抛错、绝不影响主交付(脚本本身)。解析对象是系统提示词【输出格式】第五段
 * 「Seedance 2.0 分镜提示词」的规整结构(真网关实测格式):
 *
 *   ## 镜头1：
 *   - 时长：4秒
 *   - 参考图：@图1
 *   - 中文视频提示词：<一段话，含场景/商品/运镜/无字幕约束>
 *   - 声音内容：…
 *   - 商品保持要求：…
 *   …
 *
 * 抽取 镜头号 + 参考图标签(@图N) + 中文视频提示词,供铺卡时预填 prompt、连对应参考图。
 */

import { extractMentions } from "@/lib/scriptModel";

export interface ParsedShot {
  /** 镜头序号(从 markdown 标题取)。 */
  shotNo: number;
  /** 该镜引用的素材标签(图1/视频1…,已归一,去 @)。 */
  refs: string[];
  /** 中文视频提示词(喂给下游 ai_video 卡的 prompt)。 */
  prompt: string;
  /** 时长文本(如 "4秒"),可空。 */
  duration?: string;
}

/** 逐镜段落里的字段标签(用于界定一个字段值在哪结束)。 */
const FIELD_LABELS = [
  "时长", "参考图", "中文视频提示词", "声音内容",
  "商品保持要求", "画面禁止内容", "镜头衔接建议", "画面内容",
];
const ANY_FIELD_RE = new RegExp(`^\\s*[-*]?\\s*(?:${FIELD_LABELS.join("|")})\\s*[：:]`);
const SHOT_HEADER_RE = /^#{0,4}\s*镜头\s*(\d+)\s*[：:].*$/gm;

/** 抽某字段值:从 `- 标签：值` 起,含后续续行,直到下一个字段/分隔线/镜头标题。 */
function extractField(lines: string[], label: string): string {
  const fieldRe = new RegExp(`^\\s*[-*]?\\s*${label}\\s*[：:]\\s*(.*)$`);
  let i = -1;
  for (let k = 0; k < lines.length; k++) {
    if (fieldRe.test(lines[k]!)) { i = k; break; }
  }
  if (i < 0) return "";
  const out: string[] = [];
  const firstVal = lines[i]!.match(fieldRe)![1]!.trim();
  if (firstVal) out.push(firstVal);
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (ANY_FIELD_RE.test(l)) break;
    if (/^\s*-{3,}\s*$/.test(l)) break;       // markdown 分隔线
    if (/^#{1,4}\s*镜头\s*\d/.test(l)) break; // 下一镜
    const t = l.trim();
    if (t) out.push(t);
  }
  return out.join("").trim();
}

function uniq(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

/**
 * 解析 markdown 脚本 → 逐镜 [{shotNo, refs, prompt, duration}]。
 * best-effort:无「中文视频提示词」字段的块跳过;整体抽不到返回 []。
 */
export function parseSeedanceShots(md: string): ParsedShot[] {
  if (!md) return [];
  const matches = [...md.matchAll(SHOT_HEADER_RE)];
  if (matches.length === 0) return [];

  const shots: ParsedShot[] = [];
  for (let k = 0; k < matches.length; k++) {
    const m = matches[k]!;
    const start = m.index!;
    const end = k + 1 < matches.length ? matches[k + 1]!.index! : md.length;
    const block = md.slice(start, end);
    // 只认带「中文视频提示词」的镜头块(排除第四段表格里的 "镜头" 等噪声)。
    if (!block.includes("中文视频提示词")) continue;

    const lines = block.split(/\r?\n/);
    const prompt = extractField(lines, "中文视频提示词");
    if (!prompt) continue;

    const refLine = extractField(lines, "参考图");
    const refs = uniq([...extractMentions(refLine), ...extractMentions(prompt)]);
    const duration = extractField(lines, "时长");

    shots.push({
      shotNo: Number(m[1]),
      refs,
      prompt,
      ...(duration ? { duration } : {}),
    });
  }
  return shots;
}
