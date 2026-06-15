/**
 * 节点分组(CardGroup)类型定义。
 *
 * 分组 = 把多张卡片"圈"成一个可一键运行的子单元。
 *
 * ─── 设计约束 ─────────────────────────────────────────────────
 *  • 一卡只能属于一组(强制不变式)。UI 在"成组"时若选中卡已属其它组,
 *    会先把卡片从原组移除再加入新组,而不是阻挡用户。
 *  • 不嵌套(子组里再有子组)。Figma frame 嵌套是 90% 用户的 bug 来源,
 *    本项目作为画布工具不需要这个复杂度。
 *  • Frame 容器化:bounds(x/y/width/height)**已存储**,是组的「真相源」。
 *    成员 = 中心点落在 bounds 内的卡片(空间即真相);cardIds 降级为「派生缓存」,
 *    由 frameMembership 校准权威在每次几何提交时重算并落库,折叠态冻结。
 *    详见 docs/Frame容器化-架构与施工图.md。
 *  • color 与 CARD_COLOR_PRESETS 兼容,但走独立的 GROUP_PALETTE,
 *    让组的颜色语义独立于卡片着色。
 */
export interface CardGroup {
  id: string;
  projectId: string;
  cardIds: string[];
  title: string;
  color: string;
  collapsed: boolean;
  /** Frame 边界(world 坐标)。真相源;width===0 作「未回填」哨兵(打开项目时回填)。 */
  x: number;
  y: number;
  width: number;
  height: number;
  createdAt: string;
  updatedAt: string;
}

/** SQLite 行格式。card_ids 用 JSON 字符串存;x/y/width/height 为 Frame 边界。 */
export interface CardGroupRow {
  id: string;
  project_id: string;
  card_ids: string;
  title: string;
  color: string;
  collapsed: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  created_at: string;
  updated_at: string;
}

/**
 * 组配色板。挑了 6 个跟 TYPE_COLORS 视觉上不冲突的色,
 * 默认走第一个紫色。右键"改颜色"在 M3 阶段接入。
 */
export const GROUP_PALETTE = [
  { name: "紫色", value: "#7C3AED" },
  { name: "蓝色", value: "#2563EB" },
  { name: "青色", value: "#0891B2" },
  { name: "绿色", value: "#16A34A" },
  { name: "琥珀", value: "#D97706" },
  { name: "玫红", value: "#DB2777" },
] as const;

export const DEFAULT_GROUP_COLOR = GROUP_PALETTE[0].value;

/** padding(world 单位)= 组矩形向外扩展的留白。也是子卡定位的最小安全边距。 */
export const GROUP_PADDING = 16;
/**
 * 组标题栏高度(world 单位)。和 padding 一起用于 bounds 计算。
 * 加高到 44 是为了让"运行/标题/计数"在不同 DPI 下都能清楚显示,
 * 非技术用户不需要眯眼找小按钮。文字大小见 GroupLayer.tsx。
 */
export const GROUP_TITLE_HEIGHT = 44;
/**
 * 标题栏底部到子卡顶部的额外预留高度(world 单位)。
 * 子卡上方有 CardLabel(浮在卡片顶部上方约 40px, z-30),会盖住组标题。
 * 这里预留 44 = 卡片标签 34 + translateY 6 + 安全余量 4,确保标签和标题栏不重叠。
 * 仅影响 bounds 计算,不影响 padding 语义。改 CardLabel 高度时同步调整。
 */
export const GROUP_LABEL_RESERVE = 44;
