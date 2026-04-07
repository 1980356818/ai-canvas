import { useRef, useCallback, useState, memo } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { autoSave } from "@/lib/autoSave";
import { recordUpdate } from "@/lib/history";
import { cn } from "@/lib/utils";
import { TYPE_COLORS } from "@/shared/constants";

interface CardShellProps {
  card: CanvasCard;
  selected: boolean;
  children: React.ReactNode;
}

export default memo(
  function CardShell({ card, selected, children }: CardShellProps) {
    const updateCard = useCardStore((s) => s.updateCard);
    const bringToFront = useCardStore((s) => s.bringToFront);
    const showContextMenu = useUIStore((s) => s.showContextMenu);

    const dragging = useRef(false);
    const didDrag = useRef(false);
    const dragStart = useRef({ mx: 0, my: 0, cx: 0, cy: 0 });
    const cardRef = useRef<HTMLDivElement>(null);
    const [resizing, setResizing] = useState(false);
    const resizeStart = useRef({ mx: 0, my: 0, w: 0, h: 0 });

    const accentColor = card.color || TYPE_COLORS[card.type] || "#6B7280";

    const onPointerDown = useCallback(
      (e: React.PointerEvent) => {
        if (card.locked || e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();

        const el = cardRef.current;
        if (!el) return;

        el.setPointerCapture(e.pointerId);
        el.style.zIndex = String(useCardStore.getState().maxZIndex + 1);
        el.style.willChange = "transform";

        dragging.current = true;
        didDrag.current = false;
        const zoom = useCanvasStore.getState().viewport.zoom;
        const pid = e.pointerId;
        dragStart.current = {
          mx: e.clientX,
          my: e.clientY,
          cx: card.x,
          cy: card.y,
        };

        const isEditingThis =
          useCanvasStore.getState().editingCardId === card.id;
        const editorEl = isEditingThis
          ? (document.querySelector(
              "[data-floating-editor]",
            ) as HTMLElement | null)
          : null;

        const onMove = (ev: PointerEvent) => {
          if (ev.pointerId !== pid || !dragging.current) return;
          const dx = (ev.clientX - dragStart.current.mx) / zoom;
          const dy = (ev.clientY - dragStart.current.my) / zoom;
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) didDrag.current = true;
          el.style.transform = `translate(${dx}px, ${dy}px)`;
          if (editorEl) {
            const sx = dx * zoom;
            const sy = dy * zoom;
            editorEl.style.transform = `translate(${sx}px, ${sy}px) scale(${zoom})`;
          }
        };

        const onUp = (ev: PointerEvent) => {
          if (ev.pointerId !== pid || !dragging.current) return;
          dragging.current = false;
          el.style.transform = "";
          el.style.willChange = "";
          if (editorEl) editorEl.style.transform = `scale(${zoom})`;
          el.removeEventListener("pointermove", onMove);
          el.removeEventListener("pointerup", onUp);
          el.removeEventListener("lostpointercapture", onUp);
          bringToFront(card.id);
          if (didDrag.current) {
            const dx = (ev.clientX - dragStart.current.mx) / zoom;
            const dy = (ev.clientY - dragStart.current.my) / zoom;
            recordUpdate(card.id, {
              x: dragStart.current.cx,
              y: dragStart.current.cy,
            });
            updateCard(card.id, {
              x: dragStart.current.cx + dx,
              y: dragStart.current.cy + dy,
            });
            autoSave.markDirty(card.id);
          }
        };

        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp);
        el.addEventListener("lostpointercapture", onUp);
      },
      [card.id, card.locked, card.x, card.y, bringToFront, updateCard],
    );

    const onResizePointerDown = useCallback(
      (e: React.PointerEvent) => {
        if (card.locked) return;
        e.stopPropagation();
        e.preventDefault();
        setResizing(true);
        const zoom = useCanvasStore.getState().viewport.zoom;
        resizeStart.current = {
          mx: e.clientX,
          my: e.clientY,
          w: card.width,
          h: card.height,
        };

        let rafId = 0;
        let pendingW = card.width;
        let pendingH = card.height;

        const flush = () => {
          rafId = 0;
          updateCard(card.id, { width: pendingW, height: pendingH });
        };

        const onMove = (ev: PointerEvent) => {
          const dw = (ev.clientX - resizeStart.current.mx) / zoom;
          const dh = (ev.clientY - resizeStart.current.my) / zoom;
          pendingW = Math.max(160, resizeStart.current.w + dw);
          pendingH = Math.max(80, resizeStart.current.h + dh);
          if (!rafId) rafId = requestAnimationFrame(flush);
        };

        const onUp = () => {
          if (rafId) { cancelAnimationFrame(rafId); flush(); }
          setResizing(false);
          recordUpdate(card.id, {
            width: resizeStart.current.w,
            height: resizeStart.current.h,
          });
          autoSave.markDirty(card.id);
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      },
      [card.id, card.locked, card.width, card.height, updateCard],
    );

    const onCardClick = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        if (didDrag.current) return;

        if (e.ctrlKey) {
          useCanvasStore.getState().addSelectedCardId(card.id);
        } else {
          useCanvasStore.getState().setSelectedCardIds([card.id]);
          useCanvasStore.getState().setEditingCardId(card.id);
        }
      },
      [card.id],
    );

    const onContextMenu = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        useCanvasStore.getState().setSelectedCardIds([card.id]);
        showContextMenu(e.clientX, e.clientY, "card", card.id);
      },
      [card.id, showContextMenu],
    );

    return (
      <div
        ref={cardRef}
        className="group absolute select-none"
        style={{
          left: card.x,
          top: card.y,
          width: card.width,
          height: card.height,
          zIndex: card.zIndex,
          touchAction: "none",
        }}
        onPointerDown={onPointerDown}
        onClick={onCardClick}
        onContextMenu={onContextMenu}
      >
        <div
          className={cn(
            "pointer-events-none absolute rounded-[14px] transition-opacity duration-200",
            selected
              ? "opacity-100"
              : "opacity-[0.35] group-hover:opacity-[0.55]",
          )}
          style={{
            inset: -2,
            padding: 2,
            background: `linear-gradient(135deg, ${accentColor}, #a855f7, #ec4899)`,
            WebkitMask:
              "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
            WebkitMaskComposite: "xor",
            maskComposite: "exclude",
          }}
        />

        <div
          className={cn(
            "relative h-full w-full overflow-hidden rounded-xl bg-card transition-shadow",
            selected ? "shadow-lg" : "group-hover:shadow-md",
            card.locked && "cursor-not-allowed opacity-90",
            resizing && "transition-none",
            !card.locked && "cursor-grab active:cursor-grabbing",
          )}
        >
          <div
            className="absolute left-2.5 top-2.5 z-10 h-[6px] w-[6px] rounded-full"
            style={{ backgroundColor: accentColor }}
          />
          <div className="h-full w-full overflow-hidden">{children}</div>
        </div>

        {!card.locked && (
          <div
            className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize opacity-0 transition-opacity group-hover:opacity-100"
            onPointerDown={onResizePointerDown}
          >
            <svg
              viewBox="0 0 12 12"
              className="h-3 w-3 translate-x-0.5 translate-y-0.5 text-muted-foreground/30"
            >
              <path
                d="M11 1v10H1"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M11 5v6H5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          </div>
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.card.id === next.card.id &&
    prev.card.updatedAt === next.card.updatedAt &&
    prev.card.x === next.card.x &&
    prev.card.y === next.card.y &&
    prev.card.width === next.card.width &&
    prev.card.height === next.card.height &&
    prev.card.zIndex === next.card.zIndex &&
    prev.card.locked === next.card.locked &&
    prev.selected === next.selected,
);
