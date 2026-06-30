import { useEffect, useRef, useCallback } from "react";
import { MessageSquare, ImageIcon, Video, Clapperboard } from "lucide-react";
import { useConnectionStore } from "@/stores/connectionStore";
import type { CardType } from "@/types";
import { useCardStore } from "@/stores/cardStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { autoSave } from "@/lib/autoSave";
import { connectSourcesToTarget } from "@/lib/connectActions";
import { cn } from "@/lib/utils";
import { CARD_DEFAULTS } from "@/shared/constants";

const MENU_ITEMS: Array<{ type: CardType; icon: typeof MessageSquare; label: string }> = [
  { type: "ai_chat", icon: MessageSquare, label: "文本" },
  { type: "ai_image", icon: ImageIcon, label: "图片" },
  { type: "ai_video", icon: Video, label: "视频" },
  { type: "ai_script", icon: Clapperboard, label: "帮我写" },
];

export default function WireDropMenu() {
  const pendingDrop = useConnectionStore((s) => s.pendingDrop);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    useConnectionStore.getState().setPendingDrop(null);
  }, []);

  useEffect(() => {
    if (!pendingDrop) return;

    const onClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        close();
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onClickOutside, true);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onClickOutside, true);
      window.removeEventListener("keydown", onEsc);
    };
  }, [pendingDrop, close]);

  const handleCreate = useCallback(
    (type: CardType) => {
      if (!pendingDrop) return;
      const projectId = useProjectStore.getState().currentProjectId;
      if (!projectId) return;

      const now = new Date().toISOString();
      const defaults = CARD_DEFAULTS[type];
      const { maxZIndex } = useCardStore.getState();

      const card = {
        id: crypto.randomUUID(),
        projectId,
        type,
        x: pendingDrop.canvasX - defaults.width / 2,
        y: pendingDrop.canvasY - defaults.height / 2,
        width: defaults.width,
        height: defaults.height,
        zIndex: maxZIndex + 1,
        locked: false,
        collapsed: false,
        data: { ...defaults.data },
        createdAt: now,
        updatedAt: now,
      };

      useCardStore.getState().addCard(card);

      // 扇入:把发起拖拽时选中的所有源卡都连到新建卡(单选时即原来的一条)。
      // 新卡为空,首条必然连上;若多选超出新卡容量,多出的按顺序自动跳过。
      const sourceIds =
        pendingDrop.sourceCardIds && pendingDrop.sourceCardIds.length > 0
          ? pendingDrop.sourceCardIds
          : [pendingDrop.sourceCardId];
      const { connected, rejected } = connectSourcesToTarget(
        sourceIds,
        card.id,
        projectId,
      );

      useCanvasStore.getState().setSelectedCardIds([card.id]);
      useCanvasStore.getState().setEditingCardId(card.id);

      autoSave.markDirty(card.id);

      if (sourceIds.length > 1 && connected > 0) {
        useUIStore.getState().addToast({
          type: "info",
          title: `已连接 ${connected} 个卡片到新卡片`,
          description:
            rejected > 0
              ? `${rejected} 个无法连接（类型不兼容或参考位已满）`
              : undefined,
          duration: 2500,
        });
      }
      close();
    },
    [pendingDrop, close],
  );

  if (!pendingDrop) return null;

  return (
    <div
      className="absolute z-50"
      style={{ left: pendingDrop.screenX, top: pendingDrop.screenY }}
    >
      <div
        ref={menuRef}
        className="min-w-[160px] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-lg"
      >
        <div className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground">
          创建并连接
        </div>
        {MENU_ITEMS.map(({ type, icon: Icon, label }) => (
          <button
            key={type}
            onClick={() => handleCreate(type)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-foreground transition-colors",
              "hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <Icon className="h-4 w-4 text-muted-foreground" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
