import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useUIStore } from "@/stores/uiStore";
import { useCanvasStore } from "@/stores/canvasStore";
import {
  useCardStore,
  type CanvasCard,
} from "@/stores/cardStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProjectStore } from "@/stores/projectStore";
import { deleteCard, updateProjectMeta } from "@/lib/tauri";
import { autoSave } from "@/lib/autoSave";
import { instantiateWorkflowTemplate } from "@/lib/templateFactory";
import { recordBatchDelete } from "@/lib/history";
import { cn } from "@/lib/utils";
import { CARD_DEFAULTS, WORKFLOW_TEMPLATES } from "@/shared/constants";
import type { CardType } from "@/shared/types";

const CLIPBOARD_KIND = "ai-canvas-card/v1";

function syncNodeCount(projectId: string) {
  const count = useCardStore.getState().getCardsByProject(projectId).length;
  useProjectStore.getState().updateProject(projectId, { nodeCount: count });
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
  | { type: "item"; label: string; shortcut?: string; disabled?: boolean; onSelect: (e: React.MouseEvent) => void }
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
  onSelect: (e: React.MouseEvent) => void;
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
    target: "canvas" | "card" | "multi" | "connection";
    targetId?: string;
  };
  hide: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: contextMenu.x, y: contextMenu.y });
  const projectId = useProjectStore((s) => s.currentProjectId);
  const selectedCardIds = useCanvasStore((s) => s.selectedCardIds);

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
    try {
      const text = await navigator.clipboard.readText();
      const x = contextMenu.worldX ?? clientToWorld(contextMenu.x, contextMenu.y).x;
      const y = contextMenu.worldY ?? clientToWorld(contextMenu.x, contextMenu.y).y;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as { kind?: string; card?: CanvasCard };
      } catch {
        parsed = null;
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        "kind" in parsed &&
        parsed.kind === CLIPBOARD_KIND &&
        "card" in parsed &&
        parsed.card &&
        typeof parsed.card === "object"
      ) {
        const src = parsed.card as CanvasCard;
        const now = new Date().toISOString();
        const { maxZIndex } = useCardStore.getState();
        const card: CanvasCard = {
          ...src,
          id: crypto.randomUUID(),
          projectId,
          x: x - src.width / 2,
          y: y - src.height / 2,
          zIndex: maxZIndex + 1,
          createdAt: now,
          updatedAt: now,
        };
        useCardStore.getState().addCard(card);
        autoSave.markDirty(card.id);
      } else {
        const card = buildCard("text", projectId, x, y);
        card.data = { content: text };
        useCardStore.getState().addCard(card);
        autoSave.markDirty(card.id);
      }
      syncNodeCount(projectId);
    } catch {
      /* clipboard denied or invalid */
    }
    hide();
  };

  const runCopyCard = async () => {
    const id = contextMenu.targetId;
    if (!id) return;
    const card = useCardStore.getState().getCard(id);
    if (!card) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify({ kind: CLIPBOARD_KIND, card }),
      );
    } catch {
      /* denied */
    }
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
    for (const id of ids) {
      useCardStore.getState().removeCard(id);
      try {
        await deleteCard(id);
      } catch {
        /* backend may be unavailable */
      }
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
    entries = [
      {
        type: "submenu",
        label: "添加节点",
        disabled: noProject,
        children: [
          {
            type: "item",
            label: "生成文字",
            disabled: noProject,
            onSelect: (e) => addCardAtClick("ai_chat", e),
          },
          {
            type: "item",
            label: "生成图片",
            disabled: noProject,
            onSelect: (e) => addCardAtClick("ai_image", e),
          },
          {
            type: "item",
            label: "生成视频",
            disabled: noProject,
            onSelect: (e) => addCardAtClick("ai_video", e),
          },
        ],
      },
      {
        type: "submenu",
        label: "添加模板",
        disabled: noProject,
        children: [
          {
            type: "item",
            label: "AI换衣",
            disabled: noProject,
            onSelect: (e) => addCardAtClick("ai_tryon", e),
          },
          { type: "sep" },
          ...WORKFLOW_TEMPLATES
            .filter((wf) => wf.connections && wf.connections.length > 0)
            .map((wf) => ({
              type: "item" as const,
              label: wf.name,
              disabled: noProject,
              onSelect: () => {
                if (!projectId) return;
                const world = clientToWorld(contextMenu.x, contextMenu.y);
                const cardIds = instantiateWorkflowTemplate(wf, projectId, world.x, world.y);
                useCanvasStore.getState().setSelectedCardIds(cardIds);
                syncNodeCount(projectId);
                hide();
              },
            })),
        ],
      },
      { type: "sep" },
      {
        type: "item",
        label: "粘贴",
        shortcut: "Ctrl+V",
        disabled: noProject || !navigator.clipboard?.readText,
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
    entries = [
      {
        type: "item",
        label: "复制",
        shortcut: "Ctrl+C",
        disabled: !id || !card || !navigator.clipboard?.writeText,
        onSelect: () => void runCopyCard(),
      },
      { type: "sep" },
      {
        type: "item",
        label: card?.collapsed ? "展开" : "折叠",
        disabled: !id || !card,
        onSelect: () => {
          if (!id || !card) return;
          useCardStore.getState().updateCard(id, {
            collapsed: !card.collapsed,
          });
          autoSave.markDirty(id);
          hide();
        },
      },
      {
        type: "item",
        label: card?.locked ? "解锁" : "锁定",
        disabled: !id || !card,
        onSelect: () => {
          if (!id || !card) return;
          useCardStore.getState().updateCard(id, { locked: !card.locked });
          autoSave.markDirty(id);
          hide();
        },
      },
      { type: "sep" },
      {
        type: "item",
        label: "置于顶层",
        disabled: !id,
        onSelect: () => {
          if (!id) return;
          useCardStore.getState().bringToFront(id);
          autoSave.markDirty(id);
          hide();
        },
      },
      {
        type: "item",
        label: "置于底层",
        disabled: !id,
        onSelect: () => {
          if (!id) return;
          useCardStore.getState().sendToBack(id);
          autoSave.markDirty(id);
          hide();
        },
      },
      { type: "sep" },
      {
        type: "item",
        label: "删除",
        shortcut: "Del",
        disabled: !id,
        onSelect: () => void deleteIds(id ? [id] : []),
      },
    ];
  } else if (contextMenu.target === "multi") {
    entries = [
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
        shortcut: "Del",
        disabled: !connId,
        onSelect: () => {
          if (connId) {
            useConnectionStore.getState().removeConnection(connId);
            autoSave.markDirty();
          }
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
