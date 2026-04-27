import { memo, useEffect, useRef, useState } from "react";
import { useCardStore } from "@/stores/cardStore";
import { autoSave } from "@/lib/autoSave";
import { recordUpdate } from "@/lib/history";
import { cn } from "@/lib/utils";
import { TYPE_COLORS } from "@/shared/constants";
import type { CanvasCard } from "@/types";

interface Props {
  card: CanvasCard;
}

export default memo(
  function CardLabel({ card }: Props) {
    const updateCard = useCardStore((s) => s.updateCard);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(card.title ?? "");
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      if (!editing) setDraft(card.title ?? "");
    }, [card.title, editing]);

    useEffect(() => {
      if (editing) {
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }, [editing]);

    const commit = () => {
      const next = draft.trim();
      if (next !== (card.title ?? "")) {
        recordUpdate(card.id, { title: card.title });
        updateCard(card.id, { title: next });
        autoSave.markDirty(card.id);
      }
      setEditing(false);
    };

    const cancel = () => {
      setDraft(card.title ?? "");
      setEditing(false);
    };

    const stopEvent = (e: React.SyntheticEvent) => e.stopPropagation();

    const accentColor = card.color || TYPE_COLORS[card.type] || "#6B7280";

    return (
      <div
        className="absolute left-0 z-30 flex items-end"
        style={{
          bottom: "100%",
          transform: "translateY(-6px)",
          maxWidth: card.width,
        }}
        onPointerDown={stopEvent}
        onMouseDown={stopEvent}
      >
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
              e.stopPropagation();
            }}
            onPointerDown={stopEvent}
            onMouseDown={stopEvent}
            onClick={stopEvent}
            onDoubleClick={stopEvent}
            className={cn(
              "h-[34px] rounded-md border-l-[4px] border-y border-r border-y-primary/60 border-r-primary/60",
              "bg-background pl-3 pr-2.5 text-[16px] font-semibold text-foreground outline-none",
              "shadow-md ring-2 ring-primary/30 backdrop-blur-md",
            )}
            style={{ borderLeftColor: accentColor, minWidth: 120 }}
            placeholder="未命名"
          />
        ) : (
          <button
            type="button"
            onPointerDown={stopEvent}
            onMouseDown={stopEvent}
            onClick={stopEvent}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (!card.locked) setEditing(true);
            }}
            className={cn(
              "group/label inline-flex h-[34px] max-w-full items-center gap-1.5",
              "rounded-md border-l-[4px] border-y border-r border-y-border/60 border-r-border/60",
              "bg-card pl-3 pr-3 text-[16px] font-semibold leading-none text-foreground",
              "shadow-md ring-1 ring-black/5 backdrop-blur-md transition-all dark:ring-white/10",
              "hover:bg-background hover:shadow-lg hover:ring-black/10 dark:hover:ring-white/15",
              card.locked ? "cursor-default" : "cursor-text",
            )}
            style={{ borderLeftColor: accentColor }}
            title={card.title ? `${card.title}（双击编辑）` : "双击编辑标签"}
          >
            <span className="truncate">{card.title || "未命名"}</span>
          </button>
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.card.id === next.card.id &&
    prev.card.title === next.card.title &&
    prev.card.locked === next.card.locked &&
    prev.card.color === next.card.color &&
    prev.card.type === next.card.type &&
    prev.card.width === next.card.width,
);
