/**
 * 拉取实时价格映射 `Map<sku, PriceInfo>`(IO 层)。
 *
 * 数据源 = `GET /v1/models`(不传 platform=全量,覆盖 ai-canvas 所有 SKU),
 * 复用 gateway 的 `list_models` 命令(零 Rust 改动)。每次打开价格表即拉一次,
 * 不做会话缓存 —— 价格永远实时(运营改价 / 线路熔断改代表价立即反映)。
 *
 * 纯解析逻辑(buildPriceMap / lookupPrice)在 priceMap.ts,可单测。
 */

import { listModelsWithPricing } from "@/platform/ai.api";
import { buildPriceMap } from "./priceMap";
import type { PriceInfo } from "./types";

export { buildPriceMap, lookupPrice } from "./priceMap";

/** 拉取实时价格映射。 */
export async function fetchPriceMap(): Promise<Map<string, PriceInfo>> {
  return buildPriceMap(await listModelsWithPricing("jijing"));
}
