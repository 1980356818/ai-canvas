/**
 * 价格表数据类型。
 *
 * 背景见 docs/极境价格显示-设计与施工图.md。价格表是一个**只读覆盖层**:
 * 拉极境 `/v1/models`(不传 platform=全量)→ 建 SKU→价 映射 → 用 ai-canvas
 * 现有 resolve*() 把"下拉模型 × 规格档"枚举成具体 SKU 查价。
 *
 * 客户实付价 = SKU 顶层代表价(= auto 档),与走哪条线路无关(线路价是上游成本)。
 */

export type CostType =
  | "PER_REQUEST"
  | "PER_SECOND"
  | "PER_TOKEN"
  | "PER_TOKEN_PREPAID"
  | "FREE"
  | "UNKNOWN";

/** 单个 SKU 的代表价(取自 /v1/models 模型条目顶层字段)。 */
export interface PriceInfo {
  costType: CostType;
  /** PER_REQUEST: 元/次(图=每张)。 */
  perRequest: number | null;
  /** PER_SECOND: 元/秒。 */
  perSecond: number | null;
  /** PER_TOKEN(_PREPAID): 元/百万输入 token。 */
  inputPer1m: number | null;
  /** PER_TOKEN(_PREPAID): 元/百万输出 token。 */
  outputPer1m: number | null;
}

export type PriceCapability = "IMAGE" | "VIDEO" | "CHAT";

/** 价格表的一行:某个下拉模型在某个规格档下,resolve 出的具体 SKU 及其价。 */
export interface PriceRow {
  capability: PriceCapability;
  /** 用户可见模型名(下拉里的 display_name)。 */
  modelName: string;
  /** 规格档标签("4K" / "高 · 2K" / "快速" / "" = 无可选规格)。 */
  specLabel: string;
  /** 画质档标签(低/中/高);仅 gpt-image-2 等带画质轴的图片模型有。用于矩阵渲染。 */
  quality?: string;
  /** 分辨率档标签(2K/4K);带分辨率轴的图片模型有。用于矩阵渲染。 */
  resolution?: string;
  /** resolve 后的真实 SKU(查价 / 调试用)。 */
  sku: string;
  /** 查到的价;null = 该 SKU 未在 /v1/models 中(降级显示 "—")。 */
  price: PriceInfo | null;
}
