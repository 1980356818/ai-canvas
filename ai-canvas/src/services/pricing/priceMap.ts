/**
 * 价格映射的**纯解析逻辑**(无 IO,可在 node 环境单测)。
 * IO 入口在 fetchPrices.ts。`RawPriceModel` 用 `import type` 引入 —— 编译期擦除,
 * 不会在运行时拉起 ai.api 的 Tauri 依赖,故本模块及其使用者(priceCatalog)纯净。
 */

import type { RawPriceModel } from "@/platform/ai.api";
import type { PriceInfo, CostType } from "./types";

const KNOWN_COST_TYPES: ReadonlySet<string> = new Set([
  "PER_REQUEST",
  "PER_SECOND",
  "PER_TOKEN",
  "PER_TOKEN_PREPAID",
  "FREE",
]);

/**
 * 判定 cost_type:优先取线路声明(auto 线无 cost_type,取首个有声明的);
 * 线路没给则按顶层哪个价格字段非空兜底推断。
 * (seedance 顶层价全 null 但线路 cost_type=PER_TOKEN_PREPAID → 判为按量而非免费。)
 */
function deriveCostType(m: RawPriceModel): CostType {
  const lineCt = (m.lines ?? []).find((l) => l?.cost_type)?.cost_type;
  const ct = (lineCt ?? "").toUpperCase();
  if (KNOWN_COST_TYPES.has(ct)) return ct as CostType;

  if (m.cost_per_request != null) return "PER_REQUEST";
  if (m.cost_per_second != null) return "PER_SECOND";
  if (m.input_cost_per_1m != null || m.output_cost_per_1m != null) return "PER_TOKEN";
  return "UNKNOWN";
}

function toPriceInfo(m: RawPriceModel): PriceInfo {
  return {
    costType: deriveCostType(m),
    perRequest: m.cost_per_request ?? null,
    perSecond: m.cost_per_second ?? null,
    inputPer1m: m.input_cost_per_1m ?? null,
    outputPer1m: m.output_cost_per_1m ?? null,
  };
}

/** 纯函数:模型列表 → SKU→价 映射。 */
export function buildPriceMap(models: RawPriceModel[]): Map<string, PriceInfo> {
  const map = new Map<string, PriceInfo>();
  for (const m of models) {
    if (m?.id) map.set(m.id, toPriceInfo(m));
  }
  return map;
}

/**
 * 查价:精确命中优先;对话模型的 reasoning-effort 后缀(gpt-5.5-medium)
 * 在表里不存在,回退到剥掉后缀的 base(gpt-5.5)。
 */
export function lookupPrice(map: Map<string, PriceInfo>, sku: string): PriceInfo | null {
  const hit = map.get(sku);
  if (hit) return hit;
  const stripped = sku.replace(/-(low|medium|high)$/, "");
  if (stripped !== sku) {
    const base = map.get(stripped);
    if (base) return base;
  }
  return null;
}
