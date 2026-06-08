/**
 * 价格表行集枚举。
 *
 * 行集由 `ALL_JIJING_MODELS`(= 下拉可见模型集)驱动,与下拉**始终一致**:
 *   - 图片:按 (分辨率, 画质) 枚举,复用 resolveJiJingImageModelId 得真实 SKU。
 *     哪个轴"真的改变 SKU"由 resolve 输出比对决定 —— 故 gpt-image-2-official
 *     这种 supportsQuality 但 resolve 透传的模型自动收敛成单行。
 *   - 视频:按模型族(火山 Seedance / Veo / Grok / Nexus VIP / Dale / Omni)枚举
 *     各自的胶囊档,复用对应 resolve*()。当前下拉只露 seedance-v2,但若日后
 *     取消注释 veo3.1/grok 等,这里自动跟着出行。
 *   - 对话:单行,SKU = 模型 id(查价时 lookupPrice 会剥 -medium 后缀)。
 */

import {
  JIJING_CHAT_MODELS,
  JIJING_IMAGE_MODELS,
  JIJING_VIDEO_MODELS,
  resolveJiJingImageModelId,
} from "@/providers/jijing/models";
import {
  supportsImageQuality,
  IMAGE_QUALITY_OPTIONS,
  SUPPORTED_RESOLUTIONS,
  type ImageResolution,
} from "@/shared/constants";
import {
  isSeedanceV2AliasModel,
  resolveSeedanceV2ModelId,
  SEEDANCE_V2_VERSION_TIERS,
  isVeoModel,
  VEO_TIERS,
  resolveVeoVariant,
  isGrokVideoModel,
  GROK_DURATION_TIERS,
  resolveGrokVariant,
  isSeedanceVipAliasModel,
  SEEDANCE_VIP_RESOLUTION_TIERS,
  resolveSeedanceVipModelId,
  isSeedanceModel,
  SEEDANCE_TIERS,
  resolveSeedanceVariantForTier,
  isOmniModel,
  resolveOmniModelId,
} from "@/providers/shared/video";
import type { PriceInfo, PriceRow } from "./types";
import { lookupPrice } from "./priceMap";

/** 价格表里不展示的模型(工具类:超分/放大/多角度,用户决策不显示价格)。 */
const PRICE_TABLE_HIDDEN: ReadonlySet<string> = new Set([
  "qwen-image-edit-2511-multipie",
  "Real-ESRGAN",
  "SeedVR2-Upscaler",
]);

interface Variant {
  specLabel: string;
  sku: string;
  quality?: string;
  resolution?: string;
}

/** 一个图片模型的规格档枚举(分辨率 × 画质,只保留真正改变 SKU 的轴)。 */
function imageVariants(modelId: string): Variant[] {
  const hasQuality = supportsImageQuality(modelId, "jijing");
  const defQ = hasQuality ? "medium" : undefined;

  // resolve 输出是否随该轴变化 —— 不变则该轴对此模型无意义(透传)。
  const resMatters =
    resolveJiJingImageModelId(modelId, "2K", defQ) !==
    resolveJiJingImageModelId(modelId, "4K", defQ);
  const qMatters =
    hasQuality &&
    resolveJiJingImageModelId(modelId, "2K", "low") !==
      resolveJiJingImageModelId(modelId, "2K", "high");

  const resolutions: (ImageResolution | null)[] = resMatters ? [...SUPPORTED_RESOLUTIONS] : [null];
  const qualities: ({ value: string; label: string } | null)[] = qMatters
    ? [...IMAGE_QUALITY_OPTIONS]
    : [null];

  const out: Variant[] = [];
  for (const res of resolutions) {
    for (const q of qualities) {
      const sku = resolveJiJingImageModelId(modelId, res ?? "2K", q?.value);
      const label = [q?.label, res].filter(Boolean).join(" · ");
      out.push({ specLabel: label, sku, quality: q?.label, resolution: res ?? undefined });
    }
  }
  return out;
}

/** 一个视频模型的规格档枚举(按模型族分发到对应 resolve*())。 */
function videoVariants(modelId: string): Variant[] {
  if (isSeedanceV2AliasModel(modelId)) {
    // 火山 Seedance 按 token 计费,单价随 (版本 × 是否带视频参考) 变 → 铺成 2×2 矩阵。
    const out: Variant[] = [];
    for (const t of SEEDANCE_V2_VERSION_TIERS) {
      for (const hasVideo of [false, true]) {
        const videoLabel = hasVideo ? "带视频参考" : "不带视频";
        out.push({
          specLabel: `${t.label} · ${videoLabel}`,
          sku: resolveSeedanceV2ModelId(t.value, hasVideo),
          quality: t.label, // 矩阵行轴 = 版本(标准/快速)
          resolution: videoLabel, // 矩阵列轴 = 是否带视频参考
        });
      }
    }
    return out;
  }
  if (isVeoModel(modelId)) {
    return VEO_TIERS.map((t) => ({ specLabel: t.label, sku: resolveVeoVariant(t.value) }));
  }
  if (isGrokVideoModel(modelId)) {
    return GROK_DURATION_TIERS.map((t) => ({ specLabel: t.label, sku: resolveGrokVariant(t.value) }));
  }
  if (isSeedanceVipAliasModel(modelId)) {
    return SEEDANCE_VIP_RESOLUTION_TIERS.map((t) => ({
      specLabel: t.label,
      sku: resolveSeedanceVipModelId(t.value, false),
    }));
  }
  if (isSeedanceModel(modelId)) {
    return SEEDANCE_TIERS.map((t) => ({
      specLabel: t.label,
      sku: resolveSeedanceVariantForTier(t.value),
    }));
  }
  if (isOmniModel(modelId)) {
    return [{ specLabel: "", sku: resolveOmniModelId(false) }];
  }
  return [{ specLabel: "", sku: modelId }];
}

/** 用价格映射构建整张表的行集(图片 → 视频 → 对话)。 */
export function buildPriceCatalog(map: Map<string, PriceInfo>): PriceRow[] {
  const rows: PriceRow[] = [];

  for (const m of JIJING_IMAGE_MODELS) {
    if (PRICE_TABLE_HIDDEN.has(m.id)) continue;
    for (const v of imageVariants(m.id)) {
      rows.push({
        capability: "IMAGE",
        modelName: m.display_name ?? m.id,
        specLabel: v.specLabel,
        quality: v.quality,
        resolution: v.resolution,
        sku: v.sku,
        price: lookupPrice(map, v.sku),
      });
    }
  }

  for (const m of JIJING_VIDEO_MODELS) {
    if (PRICE_TABLE_HIDDEN.has(m.id)) continue;
    for (const v of videoVariants(m.id)) {
      rows.push({
        capability: "VIDEO",
        modelName: m.display_name ?? m.id,
        specLabel: v.specLabel,
        quality: v.quality,
        resolution: v.resolution,
        sku: v.sku,
        price: lookupPrice(map, v.sku),
      });
    }
  }

  for (const m of JIJING_CHAT_MODELS) {
    if (PRICE_TABLE_HIDDEN.has(m.id)) continue;
    rows.push({
      capability: "CHAT",
      modelName: m.display_name ?? m.id,
      specLabel: "",
      sku: m.id,
      price: lookupPrice(map, m.id),
    });
  }

  return rows;
}
