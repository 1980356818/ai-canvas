import { useMemo, memo } from "react";
import { Play, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import { useGroupStore } from "@/stores/groupStore";
import { useUIStore } from "@/stores/uiStore";
import {
  useGroupRunStatusStore,
  selectGroupRunStatus,
} from "@/stores/groupRunStatusStore";
import type { CardGroup, Viewport } from "@/types";
import { GROUP_PADDING, GROUP_TITLE_HEIGHT } from "@/types/group";
import { hexAlpha } from "@/lib/utils";
import { useGroupTitleDrag } from "./hooks/useGroupDrag";
import { runGroup } from "@/services/groupRunner";

interface GroupBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 计算组的实际世界坐标 bounds(含 padding + 标题栏)。
 * 子卡全不存在 → 返回 null,调用方应跳过渲染(组将在下一次 consistency 检查中删除)。
 */
function computeBounds(group: CardGroup): GroupBounds | null {
  const cards = useCardStore.getState().cards;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let hit = 0;

  for (const cid of group.cardIds) {
    const c = cards.get(cid);
    if (!c) continue;
    hit++;
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x + c.width > maxX) maxX = c.x + c.width;
    if (c.y + c.height > maxY) maxY = c.y + c.height;
  }

  if (hit === 0) return null;

  return {
    x: minX - GROUP_PADDING,
    y: minY - GROUP_PADDING - GROUP_TITLE_HEIGHT,
    width: maxX - minX + GROUP_PADDING * 2,
    height: maxY - minY + GROUP_PADDING * 2 + GROUP_TITLE_HEIGHT,
  };
}

interface GroupShellProps {
  group: CardGroup;
  bounds: GroupBounds;
  selected: boolean;
}

/**
 * 单个组的渲染外壳。M1 阶段只渲染矩形 + 标题栏;
 * 运行按钮 / 进度徽章 / 失败态在 M2 添加。
 */
const GroupShell = memo(function GroupShell({ group, bounds, selected }: GroupShellProps) {
  const showContextMenu = useUIStore((s) => s.showContextMenu);
  const onTitleDrag = useGroupTitleDrag(group.id);
  const runStatus = useGroupRunStatusStore(selectGroupRunStatus(group.id));
  const isRunning = runStatus?.phase === "running";
  const isFailed = runStatus?.phase === "failed";
  const isCompleted = runStatus?.phase === "completed";

  const handleTitleBarPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Ctrl/Meta + 左键 = 加选(不进入拖拽)
    if (e.ctrlKey || e.metaKey) {
      e.stopPropagation();
      const canvas = useCanvasStore.getState();
      const next = new Set(canvas.selectedCardIds);
      for (const cid of group.cardIds) next.add(cid);
      canvas.setSelectedCardIds([...next]);
      return;
    }
    // 普通左键:进入"标题栏拖整组"流程,未触发拖动也会先选中组(useGroupTitleDrag 内部处理)
    onTitleDrag(e);
  };

  const handleTitleBarContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 右键之前先把组选中(让用户知道操作的是哪一组)
    useCanvasStore.getState().setSelectedCardIds([...group.cardIds]);
    showContextMenu(e.clientX, e.clientY, "group", group.id);
  };

  const handleRunClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    void runGroup(group.id);
  };

  const collapsed = group.collapsed;

  // 颜色:失败 → 红;运行/完成 → 组色;默认 → 组色淡
  const effectiveColor = isFailed ? "#EF4444" : group.color;
  const fill = hexAlpha(effectiveColor, 0.08);
  const borderColor = isFailed
    ? effectiveColor
    : selected
      ? effectiveColor
      : hexAlpha(effectiveColor, 0.5);
  const titleBg = hexAlpha(effectiveColor, isFailed ? 0.25 : 0.18);

  return (
    <div
      data-group-id={group.id}
      className="absolute pointer-events-none"
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
        // 比 cards 更靠下(cards.zIndex 默认从 1 开始递增)
        zIndex: -1,
      }}
    >
      {/* 组矩形(包括标题栏下方的空间) — 折叠态下不画矩形,只留标题栏 */}
      {!collapsed && (
        <div
          className="absolute inset-0 rounded-2xl"
          style={{
            background: fill,
            border: `${selected || isFailed ? 2 : 1.5}px ${selected || isFailed ? "solid" : "dashed"} ${borderColor}`,
            boxSizing: "border-box",
          }}
        />
      )}
      {/* 标题栏 — 唯一可交互区域。折叠态下收成胶囊,展开态下覆盖组顶部全宽 */}
      <div
        className="absolute left-0 top-0 flex items-center gap-2 px-3 cursor-pointer pointer-events-auto select-none"
        style={{
          width: collapsed ? "auto" : bounds.width,
          maxWidth: bounds.width,
          height: GROUP_TITLE_HEIGHT,
          background: titleBg,
          // 折叠态四角全圆;展开态只圆顶部
          borderRadius: collapsed ? "999px" : "1rem 1rem 0 0",
          borderBottom: collapsed ? "none" : `1px solid ${hexAlpha(effectiveColor, 0.3)}`,
          border: collapsed ? `1.5px solid ${hexAlpha(effectiveColor, 0.5)}` : undefined,
          boxSizing: "border-box",
          color: effectiveColor,
          fontSize: 12,
          fontWeight: 600,
        }}
        onPointerDown={handleTitleBarPointerDown}
        onContextMenu={handleTitleBarContextMenu}
        title={group.title}
      >
        {/* 运行按钮 / 运行态徽标 */}
        <button
          type="button"
          onClick={handleRunClick}
          onPointerDown={(e) => e.stopPropagation() /* 防止触发拖拽 */}
          disabled={isRunning}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-opacity"
          style={{
            background: hexAlpha(effectiveColor, isRunning ? 0.5 : 0.85),
            color: "#fff",
            opacity: isRunning ? 0.6 : 1,
            cursor: isRunning ? "not-allowed" : "pointer",
          }}
          title={
            isRunning
              ? "组运行中…"
              : isFailed
                ? "重新运行此组"
                : "运行此组"
          }
        >
          {isRunning ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : isFailed ? (
            <AlertCircle className="h-3 w-3" />
          ) : isCompleted ? (
            <CheckCircle2 className="h-3 w-3" />
          ) : (
            <Play className="h-3 w-3" fill="currentColor" />
          )}
        </button>

        <span className="truncate">{group.title}</span>

        <span className="ml-auto opacity-70" style={{ fontSize: 11, fontWeight: 500 }}>
          {runStatus
            ? `${runStatus.doneCount}/${runStatus.totalCount}${isFailed ? " · 已停止" : ""}`
            : `${group.cardIds.length} 个节点`}
        </span>
      </div>
    </div>
  );
});

interface GroupLayerProps {
  projectId: string | null;
  viewport: Viewport;
}

/**
 * 组渲染层 — 渲染在 CardLayer **之下**,负责画分组矩形和标题栏。
 *
 * ─── 订阅 ─────────────────────────────────────────────────────
 *  • `groupStore.version`  —— 组的增/删/cardIds 改变
 *  • `cardStore.layoutVersion` —— 子卡的几何变化(影响 bounds)
 *  • `canvasStore.selectedCardIds` —— 组的选中态(任一卡选中 = 组高亮)
 *
 * 不订阅 viewport 几何,因为整个层位于 transformed 容器内,缩放/平移由父级
 * CSS transform 处理(参考 CanvasContainer.tsx 的 showDom div)。
 */
export default memo(function GroupLayer({ projectId }: GroupLayerProps) {
  const groupVersion = useGroupStore((s) => s.version);
  const layoutVersion = useCardStore((s) => s.layoutVersion);
  const selectedCardIds = useCanvasStore((s) => s.selectedCardIds);

  // 计算所有可见组的 bounds(useMemo 用版本号 key,避免重复计算)
  const groupsToRender = useMemo(() => {
    if (!projectId) return [];
    const all = useGroupStore.getState().getGroupsByProject(projectId);
    const result: { group: CardGroup; bounds: GroupBounds }[] = [];
    for (const g of all) {
      const b = computeBounds(g);
      if (b) result.push({ group: g, bounds: b });
    }
    return result;
    // 这里的 deps 严格按"会影响输出"的来:
    //   - projectId  切项目
    //   - groupVersion  组增删/cardIds 改
    //   - layoutVersion 子卡几何改
    // 子卡 data 改不影响 bounds,所以不订 dataVersion,符合性能契约。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, groupVersion, layoutVersion]);

  if (groupsToRender.length === 0) return null;

  return (
    <>
      {groupsToRender.map(({ group, bounds }) => {
        // 组的"选中态" = 它的卡片至少有一张在 selectedCardIds 里且(简化判定)
        // 至少有一张在 selectedCardIds 里就高亮组。完全选中和部分选中不在 M1 区分。
        let selected = false;
        for (const cid of group.cardIds) {
          if (selectedCardIds.has(cid)) {
            selected = true;
            break;
          }
        }
        return (
          <GroupShell
            key={group.id}
            group={group}
            bounds={bounds}
            selected={selected}
          />
        );
      })}
    </>
  );
});
