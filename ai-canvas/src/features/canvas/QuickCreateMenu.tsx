import { useRef, useEffect, useCallback } from "react";
import { MessageSquare, ImageIcon, Video, Shirt, Type, StickyNote } from "lucide-react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import { autoSave } from "@/lib/autoSave";
import { cn } from "@/lib/utils";
import { CARD_DEFAULTS, type QuickCreateItem } from "@/shared/constants";

const QUICK_CREATE_ITEMS: QuickCreateItem[] = [
  { type: "ai_chat", icon: MessageSquare, label: CARD_DEFAULTS.ai_chat.label },
  { type: "ai_image", icon: ImageIcon, label: CARD_DEFAULTS.ai_image.label },
  { type: "ai_video", icon: Video, label: CARD_DEFAULTS.ai_video.label },
  { type: "ai_tryon", icon: Shirt, label: CARD_DEFAULTS.ai_tryon.label },
  { type: "text", icon: Type, label: CARD_DEFAULTS.text.label },
  { type: "sticky_note", icon: StickyNote, label: CARD_DEFAULTS.sticky_note.label },
];

export interface QuickMenuPosition {
  screenX: number;
  screenY: number;
  canvasX: number;
  canvasY: number;
}

interface QuickCreateMenuProps {
  position: QuickMenuPosition;
  projectId: string;
  onClose: () => void;
}

export default function QuickCreateMenu({
  position,
  projectId,
  onClose,
}: QuickCreateMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", handleClick, true);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClick, true);
      window.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  useEffect(() => {
    useCanvasStore.getState().setEditingCardId(null);
  }, []);

  const handleCreate = useCallback(
    (item: QuickCreateItem) => {
      const now = new Date().toISOString();
      const defaults = CARD_DEFAULTS[item.type];

      const card = {
        id: crypto.randomUUID(),
        projectId,
        type: item.type,
        x: position.canvasX - defaults.width / 2,
        y: position.canvasY - defaults.height / 2,
        width: defaults.width,
        height: defaults.height,
        zIndex: useCardStore.getState().maxZIndex + 1,
        locked: false,
        collapsed: false,
        data: { ...defaults.data },
        createdAt: now,
        updatedAt: now,
      };

      useCardStore.getState().addCard(card);
      useCanvasStore.getState().setSelectedCardIds([card.id]);
      useCanvasStore.getState().setEditingCardId(card.id);
      autoSave.markDirty(card.id);
      onClose();
    },
    [position, projectId, onClose],
  );

  return (
    <div
      className="absolute z-50"
      style={{ left: position.screenX, top: position.screenY }}
    >
      <div
        ref={menuRef}
        className="min-w-[160px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-lg"
      >
        {QUICK_CREATE_ITEMS.map(({ type, icon: Icon, label }) => (
          <button
            key={type}
            onClick={() => handleCreate({ type, icon: Icon, label })}
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
