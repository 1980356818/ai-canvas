import { describe, it, expect } from "vitest";
import type { RawPriceModel } from "@/platform/ai.api";
import { buildPriceMap, lookupPrice } from "./priceMap";
import { buildPriceCatalog } from "./priceCatalog";
import { formatYuan, formatPrice } from "./format";
import type { PriceRow } from "./types";

// 真实 /v1/models 抽样(2026-06-08 实测,见 docs/极境价格显示-设计与施工图.md 附录)。
const FIXTURE: RawPriceModel[] = [
  // chat
  { id: "gpt-5.5", capability: "CHAT", input_cost_per_1m: 1.4, output_cost_per_1m: 8.4,
    lines: [{ tag: "auto" }, { tag: "x", cost_type: "PER_TOKEN" }] },
  { id: "gemini-3.1-pro-preview", capability: "CHAT", cost_per_request: 0.06,
    lines: [{ tag: "auto" }, { tag: "g", cost_type: "PER_REQUEST" }] },
  // image 分档
  { id: "gpt-image-2-low-1k", capability: "IMAGE", cost_per_request: 0.084, lines: [{ tag: "oc", cost_type: "PER_REQUEST" }] },
  { id: "gpt-image-2-medium-1k", capability: "IMAGE", cost_per_request: 0.084, lines: [{ tag: "oc", cost_type: "PER_REQUEST" }] },
  { id: "gpt-image-2-high-1k", capability: "IMAGE", cost_per_request: 0.112, lines: [{ tag: "oc", cost_type: "PER_REQUEST" }] },
  { id: "gpt-image-2-low-2k", capability: "IMAGE", cost_per_request: 0.112, lines: [{ tag: "oc", cost_type: "PER_REQUEST" }] },
  { id: "gpt-image-2-medium-2k", capability: "IMAGE", cost_per_request: 0.112, lines: [{ tag: "oc", cost_type: "PER_REQUEST" }] },
  { id: "gpt-image-2-high-2k", capability: "IMAGE", cost_per_request: 0.168, lines: [{ tag: "oc", cost_type: "PER_REQUEST" }] },
  { id: "gpt-image-2-low-4k", capability: "IMAGE", cost_per_request: 0.14, lines: [{ tag: "oc", cost_type: "PER_REQUEST" }] },
  { id: "gpt-image-2-medium-4k", capability: "IMAGE", cost_per_request: 0.168, lines: [{ tag: "oc", cost_type: "PER_REQUEST" }] },
  { id: "gpt-image-2-high-4k", capability: "IMAGE", cost_per_request: 0.21, lines: [{ tag: "oc", cost_type: "PER_REQUEST" }] },
  // image 官方聚合(按 token 预扣)
  { id: "gpt-image-2-official", capability: "IMAGE", input_cost_per_1m: 78.4, output_cost_per_1m: 294,
    lines: [{ tag: "auto" }, { tag: "gh", cost_type: "PER_TOKEN_PREPAID" }] },
  // nano-banana
  { id: "nano-banana-2-2k", capability: "IMAGE", cost_per_request: 0.21, lines: [{ tag: "kr", cost_type: "PER_REQUEST" }] },
  { id: "nano-banana-2-4k", capability: "IMAGE", cost_per_request: 0.224, lines: [{ tag: "kr", cost_type: "PER_REQUEST" }] },
  { id: "nano-banana-pro-2k", capability: "IMAGE", cost_per_request: 0.336, lines: [{ tag: "kr", cost_type: "PER_REQUEST" }] },
  { id: "nano-banana-pro-4k", capability: "IMAGE", cost_per_request: 0.364, lines: [{ tag: "kr", cost_type: "PER_REQUEST" }] },
  // 单档图片
  { id: "qwen-image-edit-2511-multipie", capability: "IMAGE", cost_per_request: 0.112, lines: [{ tag: "x", cost_type: "PER_REQUEST" }] },
  { id: "Real-ESRGAN", capability: "IMAGE", cost_per_request: 0.035, lines: [{ tag: "x", cost_type: "PER_REQUEST" }] },
  { id: "SeedVR2-Upscaler", capability: "IMAGE", cost_per_request: 0.21, lines: [{ tag: "x", cost_type: "PER_REQUEST" }] },
  // video 火山 Seedance(按 token 计费,单价随 版本 × 是否带视频参考 变;output rate = upstream×1.1)
  { id: "seedance-2-0", capability: "VIDEO", output_cost_per_1m: 50.6, lines: [{ tag: "auto" }, { tag: "v", cost_type: "PER_TOKEN_PREPAID" }] },
  { id: "seedance-2-0-fast", capability: "VIDEO", output_cost_per_1m: 40.7, lines: [{ tag: "v", cost_type: "PER_TOKEN_PREPAID" }] },
  { id: "seedance-2-0-video-ref", capability: "VIDEO", output_cost_per_1m: 30.8, lines: [{ tag: "v", cost_type: "PER_TOKEN_PREPAID" }] },
  { id: "seedance-2-0-fast-video-ref", capability: "VIDEO", output_cost_per_1m: 24.2, lines: [{ tag: "v", cost_type: "PER_TOKEN_PREPAID" }] },
  { id: "seedance-2-0-mini", capability: "VIDEO", output_cost_per_1m: 25.3, lines: [{ tag: "v", cost_type: "PER_TOKEN_PREPAID" }] },
  { id: "seedance-2-0-mini-video-ref", capability: "VIDEO", output_cost_per_1m: 15.4, lines: [{ tag: "v", cost_type: "PER_TOKEN_PREPAID" }] },
];

const map = buildPriceMap(FIXTURE);
const rows = buildPriceCatalog(map);
const bySku = (sku: string, spec?: string): PriceRow | undefined =>
  rows.find((r) => r.sku === sku && (spec === undefined || r.specLabel === spec));

describe("buildPriceMap / deriveCostType", () => {
  it("derives cost type from top-level fields", () => {
    expect(map.get("gpt-image-2-high-4k")?.costType).toBe("PER_REQUEST");
    expect(map.get("gpt-5.5")?.costType).toBe("PER_TOKEN");
  });
  it("derives PER_TOKEN_PREPAID from line cost_type when top-level prices are null", () => {
    expect(map.get("seedance-2-0")?.costType).toBe("PER_TOKEN_PREPAID");
    expect(map.get("seedance-2-0")?.perRequest).toBeNull();
  });
});

describe("lookupPrice", () => {
  it("hits exact sku", () => {
    expect(lookupPrice(map, "nano-banana-2-4k")?.perRequest).toBe(0.224);
  });
  it("falls back from reasoning-effort suffix (gpt-5.5-medium → gpt-5.5)", () => {
    expect(lookupPrice(map, "gpt-5.5-medium")?.costType).toBe("PER_TOKEN");
  });
  it("returns null for unknown sku", () => {
    expect(lookupPrice(map, "does-not-exist")).toBeNull();
  });
});

describe("buildPriceCatalog", () => {
  it("expands gpt-image-2 into 9 resolution×quality rows with correct prices", () => {
    expect(bySku("gpt-image-2-low-1k", "低 · 1K")?.price?.perRequest).toBe(0.084);
    expect(bySku("gpt-image-2-high-1k", "高 · 1K")?.price?.perRequest).toBe(0.112);
    expect(bySku("gpt-image-2-low-2k", "低 · 2K")?.price?.perRequest).toBe(0.112);
    expect(bySku("gpt-image-2-high-2k", "高 · 2K")?.price?.perRequest).toBe(0.168);
    expect(bySku("gpt-image-2-low-4k", "低 · 4K")?.price?.perRequest).toBe(0.14);
    expect(bySku("gpt-image-2-high-4k", "高 · 4K")?.price?.perRequest).toBe(0.21);
    const gptImageRows = rows.filter((r) => r.modelName === "GPT Image 2");
    expect(gptImageRows).toHaveLength(9);
  });

  it("carries quality/resolution axes for matrix rendering", () => {
    const hi4k = bySku("gpt-image-2-high-4k", "高 · 4K");
    expect(hi4k?.quality).toBe("高");
    expect(hi4k?.resolution).toBe("4K");
    // nano-banana 只有分辨率轴,无画质轴(矩阵渲染会回退到行内)
    expect(bySku("nano-banana-2-4k", "4K")?.quality).toBeUndefined();
    expect(bySku("nano-banana-2-4k", "4K")?.resolution).toBe("4K");
  });

  it("collapses gpt-image-2-official to a single token-priced row (resolve ignores spec)", () => {
    const officialRows = rows.filter((r) => r.sku === "gpt-image-2-official");
    expect(officialRows).toHaveLength(1);
    expect(officialRows[0]!.specLabel).toBe("");
    expect(officialRows[0]!.price?.costType).toBe("PER_TOKEN_PREPAID");
  });

  it("expands nano-banana by resolution only (2K/4K, no phantom 1K)", () => {
    expect(bySku("nano-banana-2-2k", "2K")?.price?.perRequest).toBe(0.21);
    expect(bySku("nano-banana-2-4k", "4K")?.price?.perRequest).toBe(0.224);
    expect(bySku("nano-banana-pro-4k", "4K")?.price?.perRequest).toBe(0.364);
    // 1K 仅 gpt-image-2 系;nano-banana 不得枚举出 -1k SKU 或 "1K" 档行(防 getImageResolutionOptions 回归)。
    expect(rows.some((r) => r.sku === "nano-banana-2-1k")).toBe(false);
    expect(rows.filter((r) => r.modelName === "Nanobanana 2")).toHaveLength(2);
  });

  it("hides utility models (super-res / upscaler / multi-angle) from the table", () => {
    for (const sku of ["Real-ESRGAN", "SeedVR2-Upscaler", "qwen-image-edit-2511-multipie"]) {
      expect(rows.find((r) => r.sku === sku)).toBeUndefined();
    }
  });

  it("expands seedance-v2 into a 版本×视频参考 matrix (6 rows, incl. mini) with token rates", () => {
    const v = rows.filter((r) => r.modelName === "Seedance 2.0 官方");
    expect(v).toHaveLength(6); // V163: standard/fast/mini × 不带/带视频
    const std = bySku("seedance-2-0", "standard · 不带视频");
    expect(std?.quality).toBe("standard");
    expect(std?.resolution).toBe("不带视频");
    expect(std?.price?.costType).toBe("PER_TOKEN_PREPAID");
    expect(std?.price?.outputPer1m).toBe(50.6);
    expect(bySku("seedance-2-0-fast-video-ref", "fast · 带视频参考")?.price?.outputPer1m).toBe(24.2);
    // V163: mini 档自动出 2 行 (mini 最便宜)
    expect(bySku("seedance-2-0-mini", "mini · 不带视频")?.price?.outputPer1m).toBe(25.3);
    expect(bySku("seedance-2-0-mini-video-ref", "mini · 带视频参考")?.price?.outputPer1m).toBe(15.4);
  });

  it("prices chat models (gpt-5.5-medium alias resolves to gpt-5.5)", () => {
    const gpt = rows.find((r) => r.capability === "CHAT" && r.sku === "gpt-5.5-medium");
    expect(gpt?.price?.inputPer1m).toBe(1.4);
    expect(rows.find((r) => r.sku === "gemini-3.1-pro-preview")?.price?.perRequest).toBe(0.06);
  });
});

describe("formatYuan", () => {
  it("formats with trimmed decimals", () => {
    expect(formatYuan(0.21)).toBe("¥0.21");
    expect(formatYuan(0.112)).toBe("¥0.112");
    expect(formatYuan(1)).toBe("¥1");
    expect(formatYuan(1.5)).toBe("¥1.5");
  });
  it("treats <=0 as free", () => {
    expect(formatYuan(0)).toBe("免费");
  });
});

describe("formatPrice", () => {
  it("PER_REQUEST image → 每张", () => {
    expect(formatPrice({ costType: "PER_REQUEST", perRequest: 0.21, perSecond: null, inputPer1m: null, outputPer1m: null }, "IMAGE"))
      .toEqual({ price: "¥0.21", billing: "每张" });
  });
  it("PER_REQUEST video → 每次", () => {
    expect(formatPrice({ costType: "PER_REQUEST", perRequest: 0.336, perSecond: null, inputPer1m: null, outputPer1m: null }, "VIDEO"))
      .toEqual({ price: "¥0.336", billing: "每次" });
  });
  it("PER_SECOND → 每秒", () => {
    expect(formatPrice({ costType: "PER_SECOND", perRequest: null, perSecond: 0.05, inputPer1m: null, outputPer1m: null }, "VIDEO"))
      .toEqual({ price: "¥0.05", billing: "每秒" });
  });
  it("PER_TOKEN → 按用量 + in/out rates", () => {
    expect(formatPrice({ costType: "PER_TOKEN", perRequest: null, perSecond: null, inputPer1m: 1.4, outputPer1m: 8.4 }, "CHAT"))
      .toEqual({ price: "按用量", billing: "入¥1.4 / 出¥8.4（每百万 token）" });
  });
  it("PER_TOKEN_PREPAID without rates → 按用量 / 按 token 计费", () => {
    expect(formatPrice({ costType: "PER_TOKEN_PREPAID", perRequest: null, perSecond: null, inputPer1m: null, outputPer1m: null }, "VIDEO"))
      .toEqual({ price: "按用量", billing: "按 token 计费" });
  });
  it("null price → dash, never ¥0", () => {
    expect(formatPrice(null, "IMAGE")).toEqual({ price: "—", billing: "" });
  });
});
