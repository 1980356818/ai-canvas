/**
 * 运行输入采集 + 指纹 —— 断点续跑「输入变没变」的判据来源。
 *
 * `collectRunInputs(card)` 按类型分发到各 builder 就近导出的 `collectXInputs`,取出
 * 「会改变生成结果的输入字段」切片;`runInputFingerprint` 把它稳定哈希成短字符串。
 *
 * ─── 防漂移契约 ────────────────────────────────────────────────
 *  各 `collectXInputs` 与同文件的 `buildXRequest` 读同一份 card.data 字段子集(就近、
 *  一一对应)。改 builder 的输入字段,就近的 collect 必须同步 —— 由 runInputs.test.ts
 *  的敏感性/不敏感性断言卡住一致性。本文件只做「按 type 分发 + 哈希」,不重复字段知识。
 *
 *  采集**排除**(改它们 fp 不变):几何(x/y/w/h/zIndex)、title、color、collapsed、
 *  `_showLabel`、`selectedIndex`、以及产物字段本身(imageUrl/results/result/videoUrl…)。
 *  素材只取 url(不含 sourceCardId/width/height 等元数据)。
 */

import type { CanvasCard } from "@/types";
import { collectImageInputs } from "./buildImageRequest";
import { collectVideoInputs } from "./buildVideoRequest";
import { collectChatInputs } from "./buildChatRequest";
import { collectTryonInputs } from "./buildTryonRequest";

/**
 * 取一张卡「决定生成结果」的输入切片。无生成语义的类型(text/sticky/audio/
 * frame_extractor)返回 null —— 它们不参与指纹(新鲜度由 runFreshness 单独裁定)。
 */
export function collectRunInputs(card: CanvasCard): Record<string, unknown> | null {
  switch (card.type) {
    case "ai_image":
    case "ai_multiangle":
      return collectImageInputs(card);
    case "ai_tryon":
      return collectTryonInputs(card);
    case "ai_video":
      return collectVideoInputs(card);
    case "ai_chat":
      return collectChatInputs(card);
    default:
      return null;
  }
}

/**
 * 稳定序列化:对象按 key 排序(键序无关),数组保序(顺序是语义,如首尾帧)。
 * 与 JSON.stringify 的区别仅在对象 key 排序 —— 故 upstreamTexts / refImages 键序打乱不改 fp。
 */
function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") +
    "}"
  );
}

/** FNV-1a 32-bit 十六进制。非密码学,只需稳定 + 低碰撞,够区分「输入变没变」。 */
export function stableHash(value: unknown): string {
  const json = stableStringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 一张卡当前输入的指纹。无生成语义类型返回固定值(null 的哈希),不会被误判。 */
export function runInputFingerprint(card: CanvasCard): string {
  return stableHash(collectRunInputs(card));
}
