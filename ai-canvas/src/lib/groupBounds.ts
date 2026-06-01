/**
 * 组 bounds 的统一计算与命中入口。
 *
 * 这些工具是"分组功能基础设施"——多个模块要在同一份几何契约下工作:
 *   - GroupLayer.tsx 渲染矩形/标题栏胶囊
 *   - CardShell.tsx 拖卡 pointerup 时判定"落到哪个组"
 *   - useSelection.ts 框选时判定"框是否完整包住某个组"
 *   - canvas-renderer.ts 鸟瞰图绘制组
 *   - ContextMenu.tsx "运行此组"等命中
 *
 * 不变式:
 *   - bounds = 子卡 min/max 几何 + 上下左右 GROUP_PADDING + 顶部 GROUP_TITLE_HEIGHT
 *   - 折叠组的"实际可命中区域"= 标题栏胶囊(由 GroupLayer 渲染),而非整个 bounds
 *     hitGroupAt 内部会处理这一点
 */

import { useCardStore } from "@/stores/cardStore";
import { useGroupStore } from "@/stores/groupStore";
import type { CardGroup, CanvasCard, DragOffset } from "@/types";
import { GROUP_PADDING, GROUP_TITLE_HEIGHT, GROUP_LABEL_RESERVE } from "@/types/group";

export interface GroupBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 折叠态胶囊近似宽度(world 单位,基于 GroupShell 的 px-3 + 内部布局估算)。 */
const COLLAPSED_PILL_WIDTH = 180;

/**
 * 根据 group + 卡片快照算出 bounds。子卡全不存在 → null。
 *
 * 参数:
 *   - cards 可选,默认从 store 拿当前快照。
 *   - dragOffsets 可选:拖拽期间(整组拖、单卡多选拖等)子卡的 DOM 已被 transform,
 *     但 store 几何还没提交。传入 offsets 让 bounds 跟手不"飘"。GroupLayer 订阅
 *     dragOffsets 触发重算,渲染层 (this 也是 hover 命中) 都用同一份计算。
 */
export function computeGroupBounds(
  group: CardGroup,
  cards?: Map<string, CanvasCard>,
  dragOffsets?: Map<string, DragOffset>,
): GroupBounds | null {
  const src = cards ?? useCardStore.getState().cards;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let hit = 0;

  for (const cid of group.cardIds) {
    const c = src.get(cid);
    if (!c) continue;
    const off = dragOffsets?.get(cid);
    const ox = off?.dx ?? 0;
    const oy = off?.dy ?? 0;
    hit++;
    const cx = c.x + ox;
    const cy = c.y + oy;
    if (cx < minX) minX = cx;
    if (cy < minY) minY = cy;
    if (cx + c.width > maxX) maxX = cx + c.width;
    if (cy + c.height > maxY) maxY = cy + c.height;
  }

  if (hit === 0) return null;

  return {
    x: minX - GROUP_PADDING,
    // 顶部 = 标题栏高度 + 卡片标签预留 + 常规 padding;
    // GROUP_LABEL_RESERVE 让标题栏底部和子卡顶部之间有足够空间放 CardLabel,
    // 避免标签(z-30)盖住组标题。
    y: minY - GROUP_PADDING - GROUP_LABEL_RESERVE - GROUP_TITLE_HEIGHT,
    width: maxX - minX + GROUP_PADDING * 2,
    height:
      maxY - minY + GROUP_PADDING * 2 + GROUP_LABEL_RESERVE + GROUP_TITLE_HEIGHT,
  };
}

/**
 * 折叠态下,组真正"可见 / 可命中"的矩形 = 标题栏胶囊,
 * 位于 bounds 的左上,宽度 ~ COLLAPSED_PILL_WIDTH,高度 = GROUP_TITLE_HEIGHT。
 */
export function collapsedHitBox(bounds: GroupBounds): GroupBounds {
  return {
    x: bounds.x,
    y: bounds.y,
    width: Math.min(COLLAPSED_PILL_WIDTH, bounds.width),
    height: GROUP_TITLE_HEIGHT,
  };
}

function pointInRect(
  px: number,
  py: number,
  rect: GroupBounds,
): boolean {
  return (
    px >= rect.x &&
    px <= rect.x + rect.width &&
    py >= rect.y &&
    py <= rect.y + rect.height
  );
}

function rectContainsRect(outer: GroupBounds, inner: GroupBounds): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export interface HitOptions {
  /** 排除某些组(避免拖卡时把自己已属的组当目标)。 */
  excludeGroupIds?: Set<string>;
  /**
   * 命中区域语义:
   *   - "body"(默认): 展开组用 bounds 整体;折叠组用胶囊
   *   - "title": 只命中标题栏(用于点击区分)
   */
  region?: "body" | "title";
}

/**
 * 在 world 坐标 (x,y) 命中第一个组。多个组在该点 → 返回最后一个绘制(最上层)的;
 * 因为 GroupLayer 按 getGroupsByProject 顺序渲染,这里也按相同顺序遍历选最后一个。
 *
 * 折叠组只有标题栏胶囊响应命中,展开组整个 bounds 响应。
 */
export function hitGroupAt(
  projectId: string,
  worldX: number,
  worldY: number,
  opts: HitOptions = {},
): { group: CardGroup; bounds: GroupBounds } | null {
  const groups = useGroupStore.getState().getGroupsByProject(projectId);
  const cards = useCardStore.getState().cards;
  let hit: { group: CardGroup; bounds: GroupBounds } | null = null;

  for (const g of groups) {
    if (opts.excludeGroupIds?.has(g.id)) continue;
    const bounds = computeGroupBounds(g, cards);
    if (!bounds) continue;

    const region = g.collapsed
      ? collapsedHitBox(bounds)
      : opts.region === "title"
        ? { ...bounds, height: GROUP_TITLE_HEIGHT }
        : bounds;

    if (pointInRect(worldX, worldY, region)) {
      hit = { group: g, bounds };
    }
  }

  return hit;
}

/**
 * 找出所有 bounds 完整落在 world rect 内的组(用于框选)。
 * 折叠组只要胶囊在框内就算。
 */
export function groupsFullyInRect(
  projectId: string,
  rect: GroupBounds,
): CardGroup[] {
  const groups = useGroupStore.getState().getGroupsByProject(projectId);
  const cards = useCardStore.getState().cards;
  const result: CardGroup[] = [];

  for (const g of groups) {
    const bounds = computeGroupBounds(g, cards);
    if (!bounds) continue;
    const test = g.collapsed ? collapsedHitBox(bounds) : bounds;
    if (rectContainsRect(rect, test)) {
      result.push(g);
    }
  }

  return result;
}

/**
 * 折叠组胶囊的世界坐标中心。
 * 用于:
 *   - ConnectionLayer / canvas-renderer:把指向 collapsed 卡的连线端点收到胶囊上
 *   - Agent 工具命中
 */
export function collapsedCapsuleCenter(
  group: CardGroup,
  cards?: Map<string, CanvasCard>,
  dragOffsets?: Map<string, DragOffset>,
): { x: number; y: number } | null {
  const bounds = computeGroupBounds(group, cards, dragOffsets);
  if (!bounds) return null;
  const cap = collapsedHitBox(bounds);
  return { x: cap.x + cap.width / 2, y: cap.y + cap.height / 2 };
}

/**
 * 折叠组的"覆盖卡片"索引: cardId → 该卡所属的折叠组。
 * CardLayer/ConnectionLayer/canvas-renderer 需要一次性获取这份映射来过滤渲染。
 * 仅包含 collapsed=true 组的卡片;展开组卡片不在此 Map 中。
 *
 * 注意:订阅方需自行订阅 groupStore.version 以触发重算,本函数只取一次 snapshot。
 */
export function buildCollapsedCardIndex(projectId: string): Map<string, CardGroup> {
  const groups = useGroupStore.getState().getGroupsByProject(projectId);
  const index = new Map<string, CardGroup>();
  for (const g of groups) {
    if (!g.collapsed) continue;
    for (const cid of g.cardIds) index.set(cid, g);
  }
  return index;
}
