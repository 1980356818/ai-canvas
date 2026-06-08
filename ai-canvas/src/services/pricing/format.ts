/**
 * 价格展示格式化。对齐极境 Web `pricing.ts` 口径:
 *   ¥ 前缀;>=1 留 2 位,<1 留 4 位,去尾零;0/<=0 → "免费"。
 * cost_type 决定展示形态 —— 一律数据驱动,不假设"图=张/视频=秒/对话=token"。
 */

import type { PriceInfo, PriceCapability } from "./types";

/** 数字 → 人民币字符串。<=0 视为免费。 */
export function formatYuan(n: number): string {
  if (n <= 0) return "免费";
  const s =
    n >= 1
      ? n % 1 === 0
        ? String(n)
        : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")
      : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return `¥${s}`;
}

export interface PriceDisplay {
  /** 价格列文本(如 "¥0.21" / "按用量" / "免费" / "—")。 */
  price: string;
  /** 计费方式列文本(如 "每张" / "每秒" / "入¥1.4 / 出¥8.4（每百万 token）")。 */
  billing: string;
}

/** PriceInfo → 价格表两列文本。null/UNKNOWN 降级为 "—",绝不显示 ¥0。 */
export function formatPrice(info: PriceInfo | null, capability: PriceCapability): PriceDisplay {
  if (!info) return { price: "—", billing: "" };

  switch (info.costType) {
    case "PER_REQUEST": {
      if (info.perRequest == null) return { price: "—", billing: "" };
      const price = formatYuan(info.perRequest);
      const unit = capability === "IMAGE" ? "每张" : "每次";
      return { price, billing: price === "免费" ? "" : unit };
    }
    case "PER_SECOND": {
      if (info.perSecond == null) return { price: "—", billing: "" };
      const price = formatYuan(info.perSecond);
      return { price, billing: price === "免费" ? "" : "每秒" };
    }
    case "PER_TOKEN":
    case "PER_TOKEN_PREPAID": {
      if (info.inputPer1m != null || info.outputPer1m != null) {
        const parts: string[] = [];
        if (info.inputPer1m != null) parts.push(`入${formatYuan(info.inputPer1m)}`);
        if (info.outputPer1m != null) parts.push(`出${formatYuan(info.outputPer1m)}`);
        return { price: "按用量", billing: `${parts.join(" / ")}（每百万 token）` };
      }
      return { price: "按用量", billing: "按 token 计费" };
    }
    case "FREE":
      return { price: "免费", billing: "" };
    default:
      return { price: "—", billing: "" };
  }
}

// ── 卡片式展示用的细粒度 helper(价格表 UI) ───────────────────────────

/** 按次/按秒类的单一价格值("¥0.21" / "免费");token 类或缺价返回 null(改用 tokenRateLabel)。 */
export function priceValue(info: PriceInfo | null): string | null {
  if (!info) return null;
  if (info.costType === "PER_REQUEST" && info.perRequest != null) return formatYuan(info.perRequest);
  if (info.costType === "PER_SECOND" && info.perSecond != null) return formatYuan(info.perSecond);
  if (info.costType === "FREE") return "免费";
  return null;
}

/** 计费单位标签("每张" / "每次" / "每秒" / "按 token 计费")。 */
export function unitLabel(info: PriceInfo | null, capability: PriceCapability): string {
  if (!info) return "";
  switch (info.costType) {
    case "PER_REQUEST":
      return capability === "IMAGE" ? "每张" : "每次";
    case "PER_SECOND":
      return "每秒";
    case "PER_TOKEN":
    case "PER_TOKEN_PREPAID":
      return "按 token 计费";
    default:
      return "";
  }
}

/** token 类的费率标签("入¥1.4 · 出¥8.4 / 百万 tokens");无费率返回 null。 */
export function tokenRateLabel(info: PriceInfo | null): string | null {
  if (!info || (info.inputPer1m == null && info.outputPer1m == null)) return null;
  const parts: string[] = [];
  if (info.inputPer1m != null) parts.push(`入${formatYuan(info.inputPer1m)}`);
  if (info.outputPer1m != null) parts.push(`出${formatYuan(info.outputPer1m)}`);
  return `${parts.join(" · ")} / 百万 tokens`;
}
