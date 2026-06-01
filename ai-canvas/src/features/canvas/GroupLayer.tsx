import { useMemo, memo, useRef, useEffect } from "react";
import { Play, AlertCircle, CheckCircle2, Square, RotateCw } from "lucide-react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import { useGroupStore } from "@/stores/groupStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useUIStore } from "@/stores/uiStore";
import {
  useGroupRunStatusStore,
  selectGroupRunStatus,
} from "@/stores/groupRunStatusStore";
import type { CardGroup, Viewport } from "@/types";
import { GROUP_TITLE_HEIGHT } from "@/types/group";
import { hexAlpha } from "@/lib/utils";
import { useGroupTitleDrag } from "./hooks/useGroupDrag";
import { runGroup, cancelGroup } from "@/services/groupRunner";
import { computeGroupBounds, type GroupBounds } from "@/lib/groupBounds";
import { renameGroup } from "@/lib/groupActions";
import { focusOnCard } from "@/lib/viewport";

/**
 * 标题栏内联编辑。统一入口:
 *   - GroupLayer 标题栏双击触发(本组件 props.editing=true)
 *   - ContextMenu "重命名" 也走 uiStore.setEditingGroupId
 *
 * 行为: 自动聚焦 + 全选;Enter/失焦 = 保存(空名回退);Esc = 不保存。
 */
const GroupTitleEditor = memo(function GroupTitleEditor({
  groupId,
  initialTitle,
  color,
  onDone,
}: {
  groupId: string;
  initialTitle: string;
  color: string;
  onDone: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const commit = (value: string) => {
    const next = value.trim();
    if (next.length > 0 && next !== initialTitle) {
      renameGroup(groupId, next);
    }
    onDone();
  };

  return (
    <input
      ref={ref}
      type="text"
      defaultValue={initialTitle}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit((e.currentTarget as HTMLInputElement).value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onDone();
        }
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
      className="flex-1 bg-transparent outline-none truncate"
      style={{
        color,
        fontSize: 15,
        fontWeight: 600,
        minWidth: 60,
        borderBottom: `1px dashed ${hexAlpha(color, 0.4)}`,
      }}
      maxLength={64}
    />
  );
});

interface GroupShellProps {
  group: CardGroup;
  bounds: GroupBounds;
  selected: boolean;
  hovered: boolean;
}

/**
 * 单个组的渲染外壳。M1 阶段只渲染矩形 + 标题栏;
 * 运行按钮 / 进度徽章 / 失败态在 M2 添加。
 *
 * hovered = true 表示用户正在拖一张卡到此组上方,即将放手加入。
 * 视觉上需要明显区别于 selected(后者是"组被选中"),用浓边框 + 实线 + 轻微发光。
 */
const GroupShell = memo(function GroupShell({ group, bounds, selected, hovered }: GroupShellProps) {
  const showContextMenu = useUIStore((s) => s.showContextMenu);
  const editingGroupId = useUIStore((s) => s.editingGroupId);
  const setEditingGroupId = useUIStore((s) => s.setEditingGroupId);
  const isEditing = editingGroupId === group.id;
  const onTitleDrag = useGroupTitleDrag(group.id);
  const runStatus = useGroupRunStatusStore(selectGroupRunStatus(group.id));
  const isRunning = runStatus?.phase === "running";
  const isFailed = runStatus?.phase === "failed";
  const isCompleted = runStatus?.phase === "completed";

  const handleTitleBarPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // 编辑模式下不响应拖拽/选中(input 自己处理 stopPropagation,这里保险再拦一道)
    if (isEditing) return;
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

  const handleTitleBarDoubleClick = (e: React.MouseEvent) => {
    if (isEditing) return;
    e.stopPropagation();
    e.preventDefault();
    setEditingGroupId(group.id);
  };

  const handleTitleBarContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 右键之前先把组选中(让用户知道操作的是哪一组)
    useCanvasStore.getState().setSelectedCardIds([...group.cardIds]);
    showContextMenu(e.clientX, e.clientY, "group", group.id);
  };

  // 运行按钮的多语义:
  //   - running:点击 = 取消(F11)
  //   - failed:点击 = 跳到失败节点并选中(F8) — 避免误点重跑,重跑走右键菜单
  //   - idle/completed:点击 = 运行整组
  const handleRunClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (isRunning) {
      // F11: 取消运行;按钮在运行态已切换为 Square(停止)图标
      cancelGroup(group.id);
      return;
    }
    if (isFailed && runStatus?.failedCardId) {
      const failedId = runStatus.failedCardId;
      useCanvasStore.getState().setSelectedCardIds([failedId]);
      focusOnCard(failedId);
      return;
    }
    void runGroup(group.id);
  };

  const collapsed = group.collapsed;

  // 折叠态:统计跨组进出的"引用数",显示在 tooltip。展开态不算(性能 + 没必要)。
  const crossRefCount = useMemo(() => {
    if (!collapsed) return 0;
    const memberSet = new Set(group.cardIds);
    let n = 0;
    for (const conn of useConnectionStore.getState().connections.values()) {
      if (conn.projectId !== group.projectId) continue;
      const srcIn = memberSet.has(conn.sourceCardId);
      const tgtIn = memberSet.has(conn.targetCardId);
      if (srcIn !== tgtIn) n++; // 一端在组内一端在组外
    }
    return n;
  }, [collapsed, group.cardIds, group.projectId]);

  // 颜色:失败 → 红;运行/完成 → 组色;默认 → 组色淡
  const effectiveColor = isFailed ? "#EF4444" : group.color;
  // hovered(拖卡入组候选) 提高 fill 不透明度,边框换浓色实线,提示"放手即加入"
  const fill = hexAlpha(effectiveColor, hovered ? 0.16 : 0.08);
  const borderColor = isFailed
    ? effectiveColor
    : hovered || selected
      ? effectiveColor
      : hexAlpha(effectiveColor, 0.5);
  const titleBg = hexAlpha(effectiveColor, isFailed ? 0.25 : hovered ? 0.28 : 0.18);
  const borderStyle = hovered || selected || isFailed ? "solid" : "dashed";
  const borderWidth = hovered ? 2.5 : selected || isFailed ? 2 : 1.5;

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
            border: `${borderWidth}px ${borderStyle} ${borderColor}`,
            boxSizing: "border-box",
            boxShadow: hovered
              ? `0 0 0 4px ${hexAlpha(effectiveColor, 0.15)}`
              : undefined,
            transition: "background 120ms ease, box-shadow 120ms ease",
          }}
        />
      )}
      {/* 标题栏 — 唯一可交互区域。折叠态下收成胶囊,展开态下覆盖组顶部全宽 */}
      <div
        className="absolute left-0 top-0 flex items-center gap-2 px-4 cursor-pointer pointer-events-auto select-none"
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
          fontSize: 15,
          fontWeight: 600,
        }}
        onPointerDown={handleTitleBarPointerDown}
        onDoubleClick={handleTitleBarDoubleClick}
        onContextMenu={handleTitleBarContextMenu}
        title={
          isEditing
            ? undefined
            : collapsed
              ? `${group.title}\n${group.cardIds.length} 个节点${crossRefCount > 0 ? ` · ${crossRefCount} 条引用` : ""}\n双击改名`
              : `${group.title} (双击改名)`
        }
      >
        {/*
         * 运行按钮区。状态语义:
         *   - idle:       [▶ 运行]
         *   - running:    [■ 停止]    + 底部进度条
         *   - failed:     [⚠ 跳到失败] [↻ 重跑整组]  + 底部红进度条
         *   - completed:  [✓ 再次运行]
         * 按钮放大到 h-6 w-6(24px),组运行不再隐形;失败态拆两个按钮避免误以为没法重跑。
         */}
        <button
          type="button"
          onClick={handleRunClick}
          onPointerDown={(e) => e.stopPropagation() /* 防止触发拖拽 */}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-opacity"
          style={{
            background: hexAlpha(effectiveColor, 0.9),
            color: "#fff",
            cursor: "pointer",
          }}
          title={
            isRunning
              ? "停止运行(点击中止)"
              : isFailed
                ? "跳到失败节点 (定位卡片)"
                : isCompleted
                  ? "运行完成 · 再次运行"
                  : "运行此组"
          }
        >
          {isRunning ? (
            <Square className="h-4 w-4" fill="currentColor" />
          ) : isFailed ? (
            <AlertCircle className="h-4 w-4" />
          ) : isCompleted ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <Play className="h-4 w-4" fill="currentColor" />
          )}
        </button>

        {isFailed && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              void runGroup(group.id);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-opacity"
            style={{
              background: hexAlpha(effectiveColor, 0.25),
              color: effectiveColor,
              border: `1px solid ${hexAlpha(effectiveColor, 0.5)}`,
              cursor: "pointer",
            }}
            title="重新运行整组"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
        )}

        {isEditing ? (
          <GroupTitleEditor
            groupId={group.id}
            initialTitle={group.title}
            color={effectiveColor}
            onDone={() => setEditingGroupId(null)}
          />
        ) : (
          <span className="truncate">{group.title}</span>
        )}

        <span className="ml-auto opacity-70" style={{ fontSize: 13, fontWeight: 500 }}>
          {runStatus
            ? `${runStatus.doneCount}/${runStatus.totalCount}${isFailed ? " · 已停止" : ""}`
            : `${group.cardIds.length} 个节点`}
        </span>

        {/*
         * 运行进度条。运行中和失败态都显示("跑了 5/8 然后挂在第 6 个"用户需要这层视觉),
         * completed 态短暂保留(2.5s 后 runStatus 被清,自然消失)。
         * 放在标题栏底部 1px,与文字不抢空间。
         */}
        {runStatus && runStatus.totalCount > 0 && (
          <div
            className="pointer-events-none absolute bottom-0 left-0"
            style={{
              width: `${(runStatus.doneCount / runStatus.totalCount) * 100}%`,
              height: 2,
              background: isFailed
                ? "#EF4444"
                : isCompleted
                  ? "#22C55E"
                  : effectiveColor,
              opacity: 0.85,
              transition: "width 200ms ease",
            }}
          />
        )}
      </div>

      {/*
       * 右下角"运行"按钮 — 比标题栏小图标更醒目,带文字,适合非技术用户主操作入口。
       * 展开态才显示;折叠态下整组已收成胶囊,右下角不存在。
       * 语义同标题栏运行按钮(idle/completed=运行, running=停止, failed=跳到失败节点)。
       */}
      {!collapsed && (
        <button
          type="button"
          onClick={handleRunClick}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute pointer-events-auto flex items-center gap-1.5 rounded-full transition-all hover:brightness-110 active:scale-95 select-none"
          style={{
            right: 12,
            bottom: 12,
            paddingLeft: 14,
            paddingRight: 16,
            paddingTop: 8,
            paddingBottom: 8,
            background: isFailed
              ? "#EF4444"
              : isCompleted
                ? "#22C55E"
                : effectiveColor,
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            boxShadow: `0 2px 8px ${hexAlpha(
              isFailed ? "#EF4444" : isCompleted ? "#22C55E" : effectiveColor,
              0.45,
            )}`,
            cursor: "pointer",
          }}
          title={
            isRunning
              ? "停止运行"
              : isFailed
                ? "跳到失败节点"
                : isCompleted
                  ? "再次运行"
                  : "运行此组"
          }
        >
          {isRunning ? (
            <>
              <Square className="h-4 w-4" fill="currentColor" />
              <span>停止</span>
            </>
          ) : isFailed ? (
            <>
              <AlertCircle className="h-4 w-4" />
              <span>查看失败</span>
            </>
          ) : isCompleted ? (
            <>
              <RotateCw className="h-4 w-4" />
              <span>再次运行</span>
            </>
          ) : (
            <>
              <Play className="h-4 w-4" fill="currentColor" />
              <span>运行</span>
            </>
          )}
        </button>
      )}
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
  const dragOffsets = useCanvasStore((s) => s.dragOffsets);
  const selectedCardIds = useCanvasStore((s) => s.selectedCardIds);
  const hoverGroupId = useCanvasStore((s) => s.hoverGroupId);

  // 计算所有可见组的 bounds(useMemo 用版本号 key,避免重复计算)
  const groupsToRender = useMemo(() => {
    if (!projectId) return [];
    const all = useGroupStore.getState().getGroupsByProject(projectId);
    const result: { group: CardGroup; bounds: GroupBounds }[] = [];
    for (const g of all) {
      // 拖拽期间 dragOffsets 把子卡的"未提交位移"算进 bounds,组矩形/标题栏
      // 才能跟手。CardShell 已在 rAF 节流 setDragOffsets,频率稳定 ≤ 60fps。
      const b = computeGroupBounds(g, undefined, dragOffsets);
      if (b) result.push({ group: g, bounds: b });
    }
    return result;
    // 这里的 deps 严格按"会影响输出"的来:
    //   - projectId  切项目
    //   - groupVersion  组增删/cardIds 改
    //   - layoutVersion 子卡几何改(提交后)
    //   - dragOffsets   子卡未提交位移(拖拽中跟手)
    // 子卡 data 改不影响 bounds,所以不订 dataVersion,符合性能契约。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, groupVersion, layoutVersion, dragOffsets]);

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
            hovered={hoverGroupId === group.id}
          />
        );
      })}
    </>
  );
});
