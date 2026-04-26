import { memo, useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { useCardStore } from "@/stores/cardStore";
import { autoSave } from "@/lib/autoSave";
import { recordUpdate } from "@/lib/history";
import { cn } from "@/lib/utils";
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

    return (
      <div
        className="absolute -top-7 left-0 right-0 z-30 flex h-[22px] items-center"
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
              "h-[22px] w-full max-w-full rounded-md border border-primary/60",
              "bg-background/95 px-2 text-xs text-foreground outline-none",
              "ring-2 ring-primary/30 backdrop-blur-sm",
            )}
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
              "group/label inline-flex h-[22px] max-w-full items-center gap-1",
              "rounded-md border border-border/40 bg-background/70 px-2",
              "text-xs text-foreground/80 backdrop-blur-sm transition-colors",
              "hover:bg-background/90 hover:text-foreground",
              card.locked ? "cursor-default" : "cursor-text",
            )}
            title={card.title ? `${card.title}（双击编辑）` : "双击编辑标签"}
          >
            <span className="truncate">{card.title || "未命名"}</span>
            {!card.locked && (
              <Pencil className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/label:opacity-60" />
            )}
          </button>
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.card.id === next.card.id &&
    prev.card.title === next.card.title &&
    prev.card.locked === next.card.locked,
);
