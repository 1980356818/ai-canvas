import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useUIStore } from "@/stores/uiStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import { useGroupStore } from "@/stores/groupStore";
import type { CanvasCard, CardType } from "@/types";
import { useProjectStore } from "@/stores/projectStore";
import { deleteCard, updateProjectMeta } from "@/platform";
import { autoSave } from "@/lib/autoSave";
import { instantiateWorkflowTemplate } from "@/lib/templateFactory";
import { recordBatchDelete, recordUpdate } from "@/lib/history";
import { cn } from "@/lib/utils";
import {
  groupFromSelection,
  ungroup,
  ungroupFromSelection,
  toggleGroupCollapsed,
  setGroupColor,
  layoutGroup,
} from "@/lib/groupActions";
import { GROUP_PALETTE } from "@/types/group";
import { pruneGroupsForRemovedCards } from "@/lib/groupConsistency";
import { runGroup, stopGroup } from "@/services/groupRun";
import { useGroupRunStatusStore } from "@/stores/groupRunStatusStore";
import { CARD_DEFAULTS } from "@/shared/constants";
import { useTemplateStore } from "@/stores/templateStore";
import { useAuthStore } from "@/stores/authStore";
import { canInsertTemplate, canUseTemplate, entitlementsFromUser } from "@/lib/entitlements";
import { lockedTemplateMsg } from "@/config/membershipCopy";
import { useCategoryStore } from "@/stores/categoryStore";
import { categoryLabelMap, categoryOrderMap } from "@/config/templateCategories";
import { extractCardMedia } from "@/config/model-ref-images";
import { exportFile, revealInExplorer, batchExportFiles } from "@/lib/media";
import { copyCards, cutCards, pasteCards } from "@/lib/clipboard";
import { HIDDEN_FEATURES } from "@/config/platforms";
import {
  disconnectConnectionAndCleanup,
  removeConnectionsForCardIdsAndCleanup,
} from "@/lib/referenceConsistency";

function syncNodeCount(projectId: string) {
  const count = useCardStore.getState().getCardsByProject(projectId).length;
  const updatedAt = new Date().toISOString();
  useProjectStore.getState().updateProject(projectId, { nodeCount: count, updatedAt });
  void updateProjectMeta(projectId, { nodeCount: count });
}

function getCanvasViewportEl(): HTMLElement | null {
  return document.querySelector("[data-canvas-viewport]");
}

function clientToWorld(clientX: number, clientY: number) {
  const vp = useCanvasStore.getState().viewport;
  const root = getCanvasViewportEl();
  const rect = root?.getBoundingClientRect();
  const left = rect?.left ?? 0;
  const top = rect?.top ?? 0;
  return {
    x: (clientX - left - vp.x) / vp.zoom,
    y: (clientY - top - vp.y) / vp.zoom,
  };
}

function buildCard(
  type: CardType,
  projectId: string,
  worldX: number,
  worldY: number,
): CanvasCard {
  const now = new Date().toISOString();
  const defaults = CARD_DEFAULTS[type];
  const { maxZIndex } = useCardStore.getState();
  return {
    id: crypto.randomUUID(),
    projectId,
    type,
    x: worldX - defaults.width / 2,
    y: worldY - defaults.height / 2,
    width: defaults.width,
    height: defaults.height,
    zIndex: maxZIndex + 1,
    locked: false,
    collapsed: false,
    data: { ...defaults.data },
    createdAt: now,
    updatedAt: now,
  };
}

type MenuEntry =
  | { type: "item"; label: string; shortcut?: string; disabled?: boolean; onSelect: (e?: React.MouseEvent) => void }
  | { type: "submenu"; label: string; disabled?: boolean; children: MenuEntry[] }
  | { type: "sep" };

function MenuSeparator() {
  return <div className="my-1 h-px bg-border" role="separator" />;
}

function MenuButton({
  label,
  shortcut,
  disabled,
  onSelect,
}: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onSelect: (e?: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        if (disabled) return;
        onSelect(e);
      }}
      className={cn(
        "flex w-full items-center justify-between gap-8 rounded-md px-2 py-1.5 text-left text-sm",
        disabled
          ? "cursor-not-allowed text-muted-foreground opacity-50"
          : "text-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <span>{label}</span>
      {shortcut ? (
        <span className="text-xs text-muted-foreground">{shortcut}</span>
      ) : null}
    </button>
  );
}

function SubMenuTrigger({
  label,
  disabled,
  children,
}: {
  label: string;
  disabled?: boolean;
  children: MenuEntry[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const show = () => {
    clearTimeout(timerRef.current);
    setOpen(true);
  };
  const hide = () => {
    timerRef.current = setTimeout(() => setOpen(false), 120);
  };

  return (
    <div
      ref={ref}
      className="relative"
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      <div
        className={cn(
          "flex w-full items-center justify-between gap-4 rounded-md px-2 py-1.5 text-left text-sm",
          disabled
            ? "cursor-not-allowed text-muted-foreground opacity-50"
            : "text-foreground hover:bg-accent hover:text-accent-foreground",
        )}
      >
        <span>{label}</span>
        <svg className="h-3 w-3 text-muted-foreground" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4.5 2.5L8 6L4.5 9.5" />
        </svg>
      </div>
      {open && !disabled && (
        <div className="absolute left-full top-0 z-50 ml-1 min-w-[10rem] rounded-md border border-border bg-popover p-1 shadow-md">
          {children.map((e, i) =>
            e.type === "sep" ? (
              <MenuSeparator key={`s-${i}`} />
            ) : e.type === "submenu" ? (
              <SubMenuTrigger key={`${e.label}-${i}`} label={e.label} disabled={e.disabled} children={e.children} />
            ) : (
              <MenuButton
                key={`${e.label}-${i}`}
                label={e.label}
                shortcut={e.shortcut}
                disabled={e.disabled}
                onSelect={e.onSelect}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function ContextMenuPanel({
  contextMenu,
  hide,
}: {
  contextMenu: {
    visible: boolean;
    x: number;
    y: number;
    target: "canvas" | "card" | "multi" | "connection" | "group";
    targetId?: string;
    worldX?: number;
    worldY?: number;
  };
  hide: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: contextMenu.x, y: contextMenu.y });
  const projectId = useProjectStore((s) => s.currentProjectId);
  const selectedCardIds = useCanvasStore((s) => s.selectedCardIds);
  const isMac = useMemo(() => /mac|iphone|ipad/i.test(navigator.platform), []);
  const mod = isMac ? "⌘" : "Ctrl";

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let x = contextMenu.x;
    let y = contextMenu.y;
    const pad = 8;
    if (x + rect.width > window.innerWidth - pad) {
      x = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    if (y + rect.height > window.innerHeight - pad) {
      y = Math.max(pad, window.innerHeight - rect.height - pad);
    }
    setPos({ x, y });
  }, [contextMenu.x, contextMenu.y]);

  useEffect(() => {
    let removeListener: (() => void) | undefined;
    const t = window.setTimeout(() => {
      const onPointerDown = (e: PointerEvent) => {
        if (menuRef.current?.contains(e.target as Node)) return;
        hide();
      };
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") hide();
      };
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown, true);
      removeListener = () => {
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("keydown", onKeyDown, true);
      };
    }, 0);
    return () => {
      window.clearTimeout(t);
      removeListener?.();
    };
  }, [hide]);

  const addCardAtClick = (type: CardType, e?: React.MouseEvent) => {
    if (!projectId) return;
    let x: number, y: number;
    if (e) {
      const world = clientToWorld(e.clientX, e.clientY);
      x = world.x;
      y = world.y;
    } else {
      x = contextMenu.worldX ?? clientToWorld(contextMenu.x, contextMenu.y).x;
      y = contextMenu.worldY ?? clientToWorld(contextMenu.x, contextMenu.y).y;
    }
    const card = buildCard(type, projectId, x, y);
    useCardStore.getState().addCard(card);
    autoSave.markDirty(card.id);
    syncNodeCount(projectId);
    hide();
  };

  const runPaste = async () => {
    if (!projectId) return;
    const world = {
      worldX: contextMenu.worldX ?? clientToWorld(contextMenu.x, contextMenu.y).x,
      worldY: contextMenu.worldY ?? clientToWorld(contextMenu.x, contextMenu.y).y,
    };
    await pasteCards(projectId, world);
    hide();
  };

  const runCopyCards = async (ids: Set<string>) => {
    await copyCards(ids);
    hide();
  };

  const runCutCards = async (ids: Set<string>) => {
    await cutCards(ids);
    hide();
  };

  const fitAll = () => {
    if (!projectId) return;
    const cards = useCardStore.getState().getCardsByProject(projectId);
    if (cards.length === 0) return;
    const vp = useCanvasStore.getState().viewport;
    const vw = vp.width || window.innerWidth;
    const vh = vp.height || window.innerHeight;
    if (vw <= 0 || vh <= 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const c of cards) {
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x + c.width);
      maxY = Math.max(maxY, c.y + c.height);
    }
    const pad = 48;
    const bw = maxX - minX;
    const bh = maxY - minY;
    const zoom = Math.min(
      (vw - pad * 2) / Math.max(bw, 1),
      (vh - pad * 2) / Math.max(bh, 1),
      2,
    );
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    useCanvasStore.getState().setViewport({
      x: vw / 2 - cx * zoom,
      y: vh / 2 - cy * zoom,
      zoom,
    });
    hide();
  };

  const alignLeft = () => {
    const ids = selectedCardIds;
    if (ids.size === 0) return;
    let minX = Infinity;
    for (const id of ids) {
      const c = useCardStore.getState().getCard(id);
      if (c) minX = Math.min(minX, c.x);
    }
    if (!Number.isFinite(minX)) return;
    for (const id of ids) {
      useCardStore.getState().updateCard(id, { x: minX });
      autoSave.markDirty(id);
    }
    hide();
  };

  const alignTop = () => {
    const ids = selectedCardIds;
    if (ids.size === 0) return;
    let minY = Infinity;
    for (const id of ids) {
      const c = useCardStore.getState().getCard(id);
      if (c) minY = Math.min(minY, c.y);
    }
    if (!Number.isFinite(minY)) return;
    for (const id of ids) {
      useCardStore.getState().updateCard(id, { y: minY });
      autoSave.markDirty(id);
    }
    hide();
  };

  const deleteIds = async (ids: string[]) => {
    const cards: CanvasCard[] = [];
    for (const id of ids) {
      const c = useCardStore.getState().getCard(id);
      if (c) cards.push({ ...c });
    }
    recordBatchDelete(cards);
    removeConnectionsForCardIdsAndCleanup(ids);
    for (const id of ids) {
      useCardStore.getState().removeCard(id);
      try {
        await deleteCard(id);
      } catch {
        /* backend may be unavailable */
      }
    }
    // 同步把这些卡片从所有组里移除(空组自动删,持久化由 groupConsistency 内部处理)
    pruneGroupsForRemovedCards(ids);
    // 删掉的卡里若含「待剪切」的,取消这次剪切(剩余原卡保留,不再隐式移动)
    const cut = useCanvasStore.getState().cutCardIds;
    if (cut.size > 0 && ids.some((id) => cut.has(id))) {
      useCanvasStore.getState().clearCutCards();
    }
    useCanvasStore.getState().clearSelection();
    autoSave.markDirty();
    if (projectId) syncNodeCount(projectId);
    hide();
  };

  let entries: MenuEntry[] = [];

  if (contextMenu.target === "canvas") {
    const noProject = !projectId;
    const cards = projectId
      ? useCardStore.getState().getCardsByProject(projectId)
      : [];
    // 模板门禁:只列「当前会员可在画布直接插入」的模板(可见且可用,见 canInsertTemplate)。
    // 关键是其中的 canUseTemplate:否则试用版用户会在此菜单看到并直接实例化正式版模板(绕过付费墙)。
    const ent = entitlementsFromUser(useAuthStore.getState().user);
    const usableTemplates = useTemplateStore
      .getState()
      .templates.filter((wf) => wf.connections && wf.connections.length > 0)
      .filter((wf) => canInsertTemplate(ent, wf));
    entries = [
      {
        type: "submenu",
        label: "添加节点",
        disabled: noProject,
        children: [
          {
            type: "item",
            label: "文本",
            disabled: noProject,
            onSelect: (e) => addCardAtClick("ai_chat", e),
          },
          {
            type: "item",
            label: "图片",
            disabled: noProject,
            onSelect: (e) => addCardAtClick("ai_image", e),
          },
          {
            type: "item",
            label: "视频",
            disabled: noProject,
            onSelect: (e) => addCardAtClick("ai_video", e),
          },
          ...(!HIDDEN_FEATURES.multiangle ? [{
            type: "item" as const,
            label: "多角度",
            disabled: noProject,
            onSelect: (e?: React.MouseEvent) => addCardAtClick("ai_multiangle", e),
          }] : []),
        ],
      },
      {
        type: "submenu",
        label: "添加模板",
        disabled: noProject || usableTemplates.length === 0,
        // 模板按分类分二级子菜单(27 个平铺太长);分类顺序同首页
        children: (() => {
          const cats0 = useCategoryStore.getState().categories;
          const labelMap = categoryLabelMap(cats0);
          const orderMap = categoryOrderMap(cats0);
          const cats = [...new Set(usableTemplates.map((t) => t.category))].sort(
            (a, b) => (orderMap[a] ?? 99) - (orderMap[b] ?? 99),
          );
          return cats.map((cat) => ({
            type: "submenu" as const,
            label: labelMap[cat] ?? cat,
            disabled: noProject,
            children: usableTemplates
              .filter((wf) => wf.category === cat)
              .map((wf) => ({
                type: "item" as const,
                label: wf.name,
                disabled: noProject,
                onSelect: () => {
                  if (!projectId) return;
                  // 防御性二次校验:列表已过滤,这里对付费墙再确认一次,杜绝任何绕过。
                  if (!canUseTemplate(ent, wf)) {
                    useUIStore
                      .getState()
                      .openUpgrade(lockedTemplateMsg(wf.name));
                    hide();
                    return;
                  }
                  const world = clientToWorld(contextMenu.x, contextMenu.y);
                  void instantiateWorkflowTemplate(wf, projectId, world.x, world.y).then((cardIds) => {
                    useCanvasStore.getState().setSelectedCardIds(cardIds);
                    syncNodeCount(projectId);
                  });
                  hide();
                },
              })),
          }));
        })(),
      },
      { type: "sep" },
      {
        type: "item",
        label: "粘贴",
        shortcut: `${mod}+V`,
        disabled: noProject,
        onSelect: () => void runPaste(),
      },
      { type: "sep" },
      {
        type: "item",
        label: "总览全局",
        disabled: cards.length === 0,
        onSelect: fitAll,
      },
    ];
  } else if (contextMenu.target === "card") {
    const id = contextMenu.targetId;
    const card = id ? useCardStore.getState().getCard(id) : undefined;
    const cardMediaPath = card ? extractCardMedia(card) : null;
    const hasLocalMedia = !!cardMediaPath && !cardMediaPath.startsWith("data:") && !cardMediaPath.startsWith("http");
    const isVideo = card?.type === "ai_video";
    const showLabel = !!(card?.data as { _showLabel?: boolean } | undefined)?._showLabel;
    // F10: 该卡属于某组 → 显示"从此节点向下运行此组"
    const cardOwnerGroup = id ? useGroupStore.getState().getGroupByCardId(id) : undefined;
    entries = [
      {
        type: "item",
        label: "复制",
        shortcut: `${mod}+C`,
        disabled: !id || !card,
        onSelect: () => void runCopyCards(new Set(id ? [id] : [])),
      },
      {
        type: "item",
        label: "剪切",
        shortcut: `${mod}+X`,
        disabled: !id || !card,
        onSelect: () => void runCutCards(new Set(id ? [id] : [])),
      },
      ...(cardOwnerGroup
        ? [
            {
              type: "item" as const,
              label: "从此节点向下运行",
              disabled: !id,
              onSelect: () => {
                if (id) void runGroup(cardOwnerGroup.id, { startNodeIds: [id] });
                hide();
              },
            },
          ]
        : []),
      {
        type: "item",
        label: showLabel ? "隐藏标签" : "显示标签",
        disabled: !id || !card,
        onSelect: () => {
          if (!id || !card) return;
          recordUpdate(id, { data: { ...card.data } });
          useCardStore.getState().updateCard(id, {
            data: { ...card.data, _showLabel: !showLabel },
          });
          autoSave.markDirty(id);
          hide();
        },
      },
      {
        type: "item",
        label: isVideo ? "保存视频到本地" : "保存图片到本地",
        disabled: !hasLocalMedia,
        onSelect: () => {
          if (cardMediaPath) {
            const title = (card?.data as Record<string, unknown>)?.content as string || (isVideo ? "AI视频" : "AI图片");
            void exportFile(cardMediaPath, title, projectId ?? undefined)
              .then(() => {
                useUIStore.getState().addToast({ type: "success", title: isVideo ? "视频已导出" : "图片已导出", duration: 3000 });
              })
              .catch((err: unknown) => {
                useUIStore.getState().addToast({ type: "error", title: "导出失败", description: String(err), duration: 5000 });
              });
          }
          hide();
        },
      },
      {
        type: "item",
        label: "在文件夹中显示",
        disabled: !hasLocalMedia,
        onSelect: () => {
          if (cardMediaPath) void revealInExplorer(cardMediaPath, projectId ?? undefined);
          hide();
        },
      },
      { type: "sep" },
      {
        type: "item",
        label: "删除",
        shortcut: isMac ? "⌫" : "Del",
        disabled: !id,
        onSelect: () => void deleteIds(id ? [id] : []),
      },
    ];
  } else if (contextMenu.target === "multi") {
    const mediaCards: { storedPath: string; cardTitle: string; isVideo: boolean }[] = [];
    for (const id of selectedCardIds) {
      const c = useCardStore.getState().getCard(id);
      if (!c) continue;
      const media = extractCardMedia(c);
      if (media && !media.startsWith("data:") && !media.startsWith("http")) {
        mediaCards.push({
          storedPath: media,
          cardTitle: (c.data as Record<string, unknown>)?.content as string || c.title || (c.type === "ai_video" ? "AI视频" : "AI图片"),
          isVideo: c.type === "ai_video",
        });
      }
    }
    const imageCount = mediaCards.filter((m) => !m.isVideo).length;
    const videoCount = mediaCards.filter((m) => m.isVideo).length;
    const mediaLabel = [
      imageCount > 0 ? `${imageCount}张图片` : "",
      videoCount > 0 ? `${videoCount}个视频` : "",
    ].filter(Boolean).join(" + ");

    // 选区中是否有任意卡属于某个组(决定要不要显示"取消组合")
    const groupStore = useGroupStore.getState();
    let anyInGroup = false;
    for (const cid of selectedCardIds) {
      if (groupStore.getGroupByCardId(cid)) {
        anyInGroup = true;
        break;
      }
    }

    entries = [
      {
        type: "item",
        label: "复制",
        shortcut: `${mod}+C`,
        disabled: selectedCardIds.size === 0,
        onSelect: () => void runCopyCards(selectedCardIds),
      },
      {
        type: "item",
        label: "剪切",
        shortcut: `${mod}+X`,
        disabled: selectedCardIds.size === 0,
        onSelect: () => void runCutCards(selectedCardIds),
      },
      { type: "sep" },
      {
        type: "item",
        label: "组合",
        shortcut: `${mod}+G`,
        disabled: selectedCardIds.size < 2,
        onSelect: () => {
          groupFromSelection();
          hide();
        },
      },
      ...(anyInGroup
        ? [
            {
              type: "item" as const,
              label: "取消组合",
              shortcut: `${mod}+Shift+G`,
              disabled: false,
              onSelect: () => {
                ungroupFromSelection();
                hide();
              },
            },
          ]
        : []),
      {
        type: "item",
        label: mediaLabel ? `批量导出文件 (${mediaLabel})` : "批量导出文件",
        disabled: mediaCards.length === 0,
        onSelect: () => {
          void batchExportFiles(
            mediaCards.map((m) => ({
              storedPath: m.storedPath,
              cardTitle: m.cardTitle,
              projectId: projectId ?? undefined,
            })),
          ).then(({ success, failed }) => {
            if (failed === 0) {
              useUIStore.getState().addToast({
                type: "success",
                title: `已导出 ${success} 个文件`,
                duration: 3000,
              });
            } else {
              useUIStore.getState().addToast({
                type: "error",
                title: `导出完成：${success} 成功，${failed} 失败`,
                duration: 5000,
              });
            }
          });
          hide();
        },
      },
      { type: "sep" },
      {
        type: "item",
        label: "左对齐",
        disabled: selectedCardIds.size === 0,
        onSelect: alignLeft,
      },
      {
        type: "item",
        label: "顶部对齐",
        disabled: selectedCardIds.size === 0,
        onSelect: alignTop,
      },
      { type: "sep" },
      {
        type: "item",
        label: "全部删除",
        disabled: selectedCardIds.size === 0,
        onSelect: () => void deleteIds([...selectedCardIds]),
      },
    ];
  } else if (contextMenu.target === "connection") {
    const connId = contextMenu.targetId;
    entries = [
      {
        type: "item",
        label: "删除连线",
        shortcut: isMac ? "⌫" : "Del",
        disabled: !connId,
        onSelect: () => {
          if (connId) {
            disconnectConnectionAndCleanup(connId);
          }
          hide();
        },
      },
    ];
  } else if (contextMenu.target === "group") {
    const groupId = contextMenu.targetId;
    const group = groupId ? useGroupStore.getState().getGroup(groupId) : undefined;
    // 运行项三态:running→「停止运行」/ stopping→「正在收尾」(禁用)/ stopped→「继续(补跑)」/
    // failed→「继续(重跑失败及其后继)」/ idle→「运行此组」。跑过之后(停止/失败/完成)
    // 再额外给「重新运行整组」(rerun,无视新鲜度全跑)。
    const groupRunStatus = groupId
      ? useGroupRunStatusStore.getState().runningGroups.get(groupId)
      : undefined;
    const phase = groupRunStatus?.phase;
    const isGroupRunning = phase === "running";
    const isGroupStopping = phase === "stopping";
    const isGroupStopped = phase === "stopped";
    const isGroupFailed = phase === "failed";
    const ranBefore = isGroupStopped || isGroupFailed || phase === "completed";
    entries = [
      {
        type: "item",
        label: isGroupRunning
          ? "停止运行"
          : isGroupStopping
            ? "正在收尾…"
            : isGroupStopped
              ? "继续(补跑未运行的节点)"
              : isGroupFailed
                ? "继续(重跑失败节点及其后继)"
                : "运行此组",
        disabled: !group || group.cardIds.length === 0 || isGroupStopping,
        onSelect: () => {
          if (!groupId) return;
          if (isGroupRunning) stopGroup(groupId);
          else if (isGroupStopped) void runGroup(groupId, { mode: "resume" });
          else if (isGroupFailed) void runGroup(groupId, { onlyFailed: true });
          else void runGroup(groupId);
          hide();
        },
      },
      ...(ranBefore
        ? [
            {
              type: "item" as const,
              label: "重新运行整组",
              disabled: false,
              onSelect: () => {
                if (groupId) void runGroup(groupId, { mode: "rerun" });
                hide();
              },
            },
          ]
        : []),
      {
        type: "item",
        label: "重命名",
        disabled: !groupId,
        onSelect: () => {
          if (groupId) useUIStore.getState().setEditingGroupId(groupId);
          hide();
        },
      },
      {
        type: "item",
        label: group?.collapsed ? "展开" : "折叠",
        disabled: !groupId,
        onSelect: () => {
          if (groupId) toggleGroupCollapsed(groupId);
          hide();
        },
      },
      {
        type: "submenu",
        label: "颜色",
        disabled: !groupId,
        children: GROUP_PALETTE.map((c) => ({
          type: "item" as const,
          label: c.name,
          disabled: false,
          onSelect: () => {
            if (groupId) setGroupColor(groupId, c.value);
            hide();
          },
        })),
      },
      {
        type: "submenu",
        label: "组内排版",
        disabled: !groupId || !group || group.cardIds.length < 2,
        children: [
          {
            type: "item",
            label: "横向排列",
            disabled: false,
            onSelect: () => {
              if (groupId) layoutGroup(groupId, "horizontal");
              hide();
            },
          },
          {
            type: "item",
            label: "纵向排列",
            disabled: false,
            onSelect: () => {
              if (groupId) layoutGroup(groupId, "vertical");
              hide();
            },
          },
          {
            type: "item",
            label: "网格排列",
            disabled: false,
            onSelect: () => {
              if (groupId) layoutGroup(groupId, "grid");
              hide();
            },
          },
        ],
      },
      { type: "sep" },
      {
        type: "item",
        label: "取消组合",
        shortcut: `${mod}+Shift+G`,
        disabled: !groupId,
        onSelect: () => {
          if (groupId) ungroup(groupId);
          hide();
        },
      },
    ];
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[12rem] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
    >
      {entries.map((e, i) =>
        e.type === "sep" ? (
          <MenuSeparator key={`s-${i}`} />
        ) : e.type === "submenu" ? (
          <SubMenuTrigger key={`${e.label}-${i}`} label={e.label} disabled={e.disabled} children={e.children} />
        ) : (
          <MenuButton
            key={`${e.label}-${i}`}
            label={e.label}
            shortcut={e.shortcut}
            disabled={e.disabled}
            onSelect={() => {
              e.onSelect();
            }}
          />
        ),
      )}
    </div>
  );
}

export function ContextMenu() {
  const contextMenu = useUIStore((s) => s.contextMenu);
  const hideContextMenu = useUIStore((s) => s.hideContextMenu);

  const hide = useCallback(() => {
    hideContextMenu();
  }, [hideContextMenu]);

  if (!contextMenu.visible) return null;

  return (
    <ContextMenuPanel
      key={`${contextMenu.x}-${contextMenu.y}-${contextMenu.target}-${contextMenu.targetId ?? ""}`}
      contextMenu={contextMenu}
      hide={hide}
    />
  );
}
