/**
 * 提示词「障眼法」编解码 —— 试用版(trial)模板把提示词以 `ENC1::` 编码存进定义,
 * 让 `GET /api/templates`、localStorage、编辑器 DOM 里看到的都是乱码,不让 casual
 * 一眼看见明文。
 *
 * ⚠️ **这是障眼法,不是加密。** KEY 编在客户端 bundle 里,决心扒 bundle 或抓生成
 * 请求(明文发上游)仍可还原 —— 用户已确认不防这层(见
 * `docs/平面模板试用版-提示词封装-施工图.md`)。真正不可绕过需服务端生成代理。
 *
 * 编码端是派生脚本 `scripts/promptcloak.py`,**必须与本文件同算法、同 KEY、同 MARK**;
 * 改任一处必须两端同步改,否则客户端解不开 → 试用卡把乱码当提示词发上游。
 * 跨语言一致性由 `services/generation/__tests__/buildRequests.test.ts` 用 Python 产出的
 * 固定串对拍守护。
 *
 * 算法:`utf8(s)` → 逐字节 XOR 循环 KEY → base64 → 前缀 `ENC1::`。
 */

const KEY = "ac-trial-cloak-2026";
const MARK = "ENC1::";
const keyBytes = new TextEncoder().encode(KEY);

/** 逐字节 XOR 循环 KEY(自反:同一函数既加也解)。 */
function xorCycle(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[i]! ^ keyBytes[i % keyBytes.length]!;
  }
  return out;
}

/** 是否是 `ENC1::` 编码串。 */
export function isCloaked(s: string | undefined | null): boolean {
  return typeof s === "string" && s.startsWith(MARK);
}

/**
 * 解开 `ENC1::` 编码的提示词。
 *
 * 非编码文本(普通模板 / 用户手输 / 空 / undefined)**原样透传**,所以调用方可在
 * 「读 content」处无条件套用,对非试用卡零副作用。解码异常时回退原串(宁可发原值
 * 也不抛,至少不崩生成)。
 */
export function uncloakPrompt(s: string | undefined | null): string {
  if (typeof s !== "string" || !s.startsWith(MARK)) return s ?? "";
  try {
    const bin = atob(s.slice(MARK.length));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(xorCycle(bytes));
  } catch {
    return s;
  }
}

/**
 * 明文 → `ENC1::` 串。
 *
 * 运行时**不需要**(客户端只解码);仅供单测与 `scripts/promptcloak.py` 对拍。
 * 空串 / 已编码串原样返回(幂等)。
 */
export function cloakPrompt(s: string | undefined | null): string {
  if (typeof s !== "string" || s.length === 0 || s.startsWith(MARK)) return s ?? "";
  const xored = xorCycle(new TextEncoder().encode(s));
  let bin = "";
  for (const b of xored) bin += String.fromCharCode(b);
  return MARK + btoa(bin);
}
