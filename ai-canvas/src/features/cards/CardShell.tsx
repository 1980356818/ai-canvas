import { useRef, useCallback, useState, memo } from "react";
import { GripVertical } from "lucide-react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { useConnectionStore, type Connection } from "@/stores/connectionStore";
import { useProjectStore } from "@/stores/projectStore";
import { autoSave } from "@/lib/autoSave";
import { recordUpdate } from "@/lib/history";
import { cn } from "@/lib/utils";
import { TYPE_COLORS, sizeFromRatio } from "@/shared/constants";
import {
  cardHasImage,
  extractCardImage,
  CARD_REF_MIME,
  type CardRefPayload,
} from "@/config/model-ref-images";
import {
  canAcceptImageConnection,
  injectOnConnect,
} from "@/lib/dataFlow";

function findInputPortAt(
  clientX: number,
  clientY: number,
  excludeCardId: string,
): HTMLElement | null {
  const els = document.elementsFromPoint(clientX, clientY);
  for (const el of els) {
    const port = el.closest("[data-port-input]") as HTMLElement | null;
    if (port && port.dataset.cardId !== excludeCardId) return port;
  }
  return null;
}

const Port = memo(function Port({
  side,
  cardId,
  color,
}: {
  side: "input" | "output";
  cardId: string;
  color: string;
}) {
  const isOutput = side === "output";
  const isDraftTarget = useConnectionStore(
    (s) => !isOutput && s.draftWire !== null && s.draftWire.sourceCardId !== cardId,
  );

  const onPortPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!isOutput) return;
      e.stopPropagation();
      e.preventDefault();

      const card = useCardStore.getState().getCard(cardId);
      if (!card) return;
      const portX = card.x + card.width;
      const portY = card.y + card.height / 2;

      useConnectionStore
        .getState()
        .setDraftWire({
          sourceCardId: cardId,
          startX: portX,
          startY: portY,
          endX: portX,
          endY: portY,
        });

      let lastHighlight: HTMLElement | null = null;

      const onMove = (ev: PointerEvent) => {
        ev.preventDefault();
        const vp = useCanvasStore.getState().viewport;
        const current = useConnectionStore.getState().draftWire;
        if (current) {
          useConnectionStore
            .getState()
            .setDraftWire({
              ...current,
              endX: current.endX + ev.movementX / vp.zoom,
              endY: current.endY + ev.movementY / vp.zoom,
            });
        }

        const target = findInputPortAt(ev.clientX, ev.clientY, cardId);
        if (target !== lastHighlight) {
          lastHighlight?.classList.remove("port-drop-target");
          target?.classList.add("port-drop-target");
          lastHighlight = target;
        }
      };

      const onUp = (ev: PointerEvent) => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        lastHighlight?.classList.remove("port-drop-target");

        useConnectionStore.getState().setDraftWire(null);

        const target = findInputPortAt(ev.clientX, ev.clientY, cardId);
        if (target) {
          const targetCardId = target.dataset.cardId;
          const projectId = useProjectStore.getState().currentProjectId;
          if (
            targetCardId &&
            projectId &&
            !useConnectionStore
              .getState()
              .hasConnection(cardId, targetCardId)
          ) {
            if (!canAcceptImageConnection(targetCardId, cardId)) {
              useUIStore.getState().addToast({
                type: "warning",
                title: "参考图已满",
                description:
                  "该卡片的参考图位已全部占用，请先移除已有参考图或断开连线",
                duration: 3000,
              });
              return;
            }

            const conn: Connection = {
              id: crypto.randomUUID(),
              projectId,
              sourceCardId: cardId,
              targetCardId,
              createdAt: new Date().toISOString(),
            };
            useConnectionStore.getState().addConnection(conn);
            autoSave.markDirty();
            injectOnConnect(cardId, targetCardId);
          }
        }
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    },
    [cardId, isOutput],
  );

  return (
    <div
      data-port-input={!isOutput ? "" : undefined}
      data-port-output={isOutput ? "" : undefined}
      data-card-id={cardId}
      className={cn(
        "absolute top-1/2 z-20 -translate-y-1/2 transition-transform duration-150",
        isOutput ? "right-0 translate-x-1/2" : "left-0 -translate-x-1/2",
        isDraftTarget && "scale-[1.4]",
      )}
      onPointerDown={onPortPointerDown}
    >
      <div
        className={cn(
          "port-socket flex items-center justify-center rounded-full",
          "h-[18px] w-[18px] transition-all duration-150",
          isOutput ? "cursor-crosshair" : "cursor-default",
          isDraftTarget && "animate-pulse",
        )}
        style={{
          border: `2px solid ${color}`,
          borderColor: isDraftTarget ? color : `color-mix(in srgb, ${color} 55%, transparent)`,
          background: isDraftTarget
            ? `color-mix(in srgb, ${color} 25%, transparent)`
            : `color-mix(in srgb, ${color} 8%, transparent)`,
          boxShadow: isDraftTarget
            ? `0 0 12px ${color}88, inset 0 1px 3px rgba(0,0,0,0.2)`
            : `inset 0 1px 3px rgba(0,0,0,0.2)`,
        }}
      >
        <div
          className="h-2 w-2 rounded-full transition-all duration-150"
          style={{
            background: color,
            boxShadow: `0 0 5px ${color}99`,
          }}
        />
      </div>
    </div>
  );
});

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
        el.style.cursor = "move";

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

        const thisHasImage = cardHasImage(card);
        let lastHoveredSlot: Element | null = null;

        const findSlotBelow = (cx: number, cy: number): Element | null => {
          if (!thisHasImage) return null;
          const prev = el.style.pointerEvents;
          el.style.pointerEvents = "none";
          const below = document.elementFromPoint(cx, cy);
          el.style.pointerEvents = prev;
          return below?.closest("[data-ref-slot]") ?? null;
        };

        let lastHoveredCardEl: HTMLElement | null = null;
        let hoverReadyCardId: string | null = null;
        let hoverTimerId: ReturnType<typeof setTimeout> | null = null;
        const HOVER_HOLD_MS = 250;

        const findAcceptingCardBelow = (
          cx: number,
          cy: number,
        ): HTMLElement | null => {
          if (!thisHasImage) return null;
          const prev = el.style.pointerEvents;
          el.style.pointerEvents = "none";
          const below = document.elementFromPoint(cx, cy);
          el.style.pointerEvents = prev;
          const cardBelow = below?.closest(
            "[data-card-id]",
          ) as HTMLElement | null;
          if (!cardBelow || cardBelow.dataset.cardId === card.id) return null;
          const belowId = cardBelow.dataset.cardId!;
          const belowCard = useCardStore.getState().getCard(belowId);
          if (
            !belowCard ||
            useUIStore.getState().generatingCards.has(belowId)
          )
            return null;
          if (
            belowCard.type === "ai_image" &&
            !(belowCard.data as { imageUrl?: string }).imageUrl
          )
            return cardBelow;
          if (belowCard.type === "ai_tryon") {
            const d = belowCard.data as {
              personImageUrl?: string;
              garmentImageUrl?: string;
            };
            if (!d.personImageUrl || !d.garmentImageUrl) return cardBelow;
          }
          return null;
        };

        let selectedIds = useCanvasStore.getState().selectedCardIds;
        if (!selectedIds.has(card.id) && !e.ctrlKey) {
          useCanvasStore.getState().setSelectedCardIds([card.id]);
          selectedIds = useCanvasStore.getState().selectedCardIds;
        }
        const isGroupDrag = selectedIds.has(card.id) && selectedIds.size > 1;
        const peerStarts = new Map<string, { cx: number; cy: number; el: HTMLElement | null }>();
        if (isGroupDrag) {
          const allCards = useCardStore.getState().cards;
          for (const sid of selectedIds) {
            if (sid === card.id) continue;
            const sc = allCards.get(sid);
            if (!sc) continue;
            const sel = document.querySelector(`[data-card-id="${sid}"]`) as HTMLElement | null;
            peerStarts.set(sid, { cx: sc.x, cy: sc.y, el: sel });
          }
        }

        const onMove = (ev: PointerEvent) => {
          if (ev.pointerId !== pid || !dragging.current) return;
          const dx = (ev.clientX - dragStart.current.mx) / zoom;
          const dy = (ev.clientY - dragStart.current.my) / zoom;
          const screenDx = ev.clientX - dragStart.current.mx;
          const screenDy = ev.clientY - dragStart.current.my;
          if (Math.abs(screenDx) > 5 || Math.abs(screenDy) > 5) didDrag.current = true;
          el.style.transform = `translate(${dx}px, ${dy}px)`;
          if (editorEl) {
            const sx = dx * zoom;
            const sy = dy * zoom;
            editorEl.style.transform = `translate(${sx}px, ${sy}px) scale(${zoom})`;
          }

          if (isGroupDrag) {
            const offsets = new Map<string, { dx: number; dy: number }>();
            offsets.set(card.id, { dx, dy });
            for (const [sid, peer] of peerStarts) {
              if (peer.el) peer.el.style.transform = `translate(${dx}px, ${dy}px)`;
              offsets.set(sid, { dx, dy });
            }
            useCanvasStore.getState().setDragOffsets(offsets);
          } else {
            useCanvasStore.getState().setDragOffset(card.id, { dx, dy });
          }

          const slotEl = findSlotBelow(ev.clientX, ev.clientY);
          if (slotEl !== lastHoveredSlot) {
            lastHoveredSlot?.dispatchEvent(
              new CustomEvent("canvas-card-hover", { detail: { active: false } }),
            );
            slotEl?.dispatchEvent(
              new CustomEvent("canvas-card-hover", { detail: { active: true } }),
            );
            lastHoveredSlot = slotEl;
          }

          const acceptCardEl = findAcceptingCardBelow(ev.clientX, ev.clientY);
          if (acceptCardEl !== lastHoveredCardEl) {
            if (lastHoveredCardEl) {
              lastHoveredCardEl.classList.remove(
                "card-image-hover",
                "card-image-ready",
              );
              if (hoverTimerId) {
                clearTimeout(hoverTimerId);
                hoverTimerId = null;
              }
              hoverReadyCardId = null;
            }
            lastHoveredCardEl = acceptCardEl;
            if (acceptCardEl) {
              acceptCardEl.classList.add("card-image-hover");
              const targetId = acceptCardEl.dataset.cardId!;
              hoverTimerId = setTimeout(() => {
                acceptCardEl.classList.remove("card-image-hover");
                acceptCardEl.classList.add("card-image-ready");
                hoverReadyCardId = targetId;
                hoverTimerId = null;
              }, HOVER_HOLD_MS);
            }
          }
        };

        const onUp = (ev: PointerEvent) => {
          if (ev.pointerId !== pid || !dragging.current) return;
          dragging.current = false;
          el.style.transform = "";
          el.style.willChange = "";
          el.style.cursor = "";
          if (editorEl) editorEl.style.transform = `scale(${zoom})`;
          el.removeEventListener("pointermove", onMove);
          el.removeEventListener("pointerup", onUp);
          el.removeEventListener("lostpointercapture", onUp);

          if (isGroupDrag) {
            for (const [, peer] of peerStarts) {
              if (peer.el) {
                peer.el.style.transform = "";
                peer.el.style.willChange = "";
              }
            }
            useCanvasStore.getState().clearDragOffsets([card.id, ...peerStarts.keys()]);
          } else {
            useCanvasStore.getState().setDragOffset(card.id, null);
          }

          lastHoveredSlot?.dispatchEvent(
            new CustomEvent("canvas-card-hover", { detail: { active: false } }),
          );

          if (lastHoveredCardEl) {
            lastHoveredCardEl.classList.remove(
              "card-image-hover",
              "card-image-ready",
            );
            if (hoverTimerId) {
              clearTimeout(hoverTimerId);
              hoverTimerId = null;
            }
          }

          if (didDrag.current && thisHasImage && !isGroupDrag) {
            if (hoverReadyCardId) {
              const imgUrl = extractCardImage(card);
              if (imgUrl) {
                const target = useCardStore
                  .getState()
                  .getCard(hoverReadyCardId);
                if (target) {
                  const d = {
                    ...target.data,
                  } as Record<string, unknown>;
                  const patch: Partial<CanvasCard> = { data: d };
                  if (target.type === "ai_image") {
                    d.imageUrl = imgUrl;
                    const ratio = card.width / card.height;
                    const sized = sizeFromRatio(ratio);
                    const cx = target.x + target.width / 2;
                    const cy = target.y + target.height / 2;
                    patch.x = cx - sized.width / 2;
                    patch.y = cy - sized.height / 2;
                    patch.width = sized.width;
                    patch.height = sized.height;
                  } else if (target.type === "ai_tryon") {
                    if (!d.personImageUrl) d.personImageUrl = imgUrl;
                    else if (!d.garmentImageUrl) d.garmentImageUrl = imgUrl;
                  }
                  useCardStore
                    .getState()
                    .updateCard(hoverReadyCardId, patch);
                  autoSave.markDirty(hoverReadyCardId);
                  useUIStore.getState().addToast({
                    type: "info",
                    title: "图片已放置到目标卡片",
                    duration: 2000,
                  });
                }
                bringToFront(card.id);
                return;
              }
            }

            const slotEl = findSlotBelow(ev.clientX, ev.clientY);
            if (slotEl) {
              const imgUrl = extractCardImage(card);
              if (imgUrl) {
                slotEl.dispatchEvent(
                  new CustomEvent("canvas-card-drop", {
                    detail: { cardId: card.id, imageUrl: imgUrl },
                  }),
                );
                bringToFront(card.id);
                return;
              }
            }
          }

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

            if (isGroupDrag) {
              for (const [sid, peer] of peerStarts) {
                recordUpdate(sid, { x: peer.cx, y: peer.cy });
                updateCard(sid, { x: peer.cx + dx, y: peer.cy + dy });
                autoSave.markDirty(sid);
              }
            }

            if (!ev.ctrlKey && !isGroupDrag) {
              useCanvasStore.getState().setSelectedCardIds([card.id]);
            }
          } else {
            const pm = useCanvasStore.getState().pickMode;
            if (pm?.active) {
              const imgUrl = extractCardImage(card);
              if (imgUrl) pm.onPick(card.id, imgUrl);
            } else if (ev.ctrlKey) {
              useCanvasStore.getState().addSelectedCardId(card.id);
            } else {
              useCanvasStore.getState().setSelectedCardIds([card.id]);
              useCanvasStore.getState().setEditingCardId(card.id);
            }
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

    const hasImage = cardHasImage(card);

    const onRefDragStart = useCallback(
      (e: React.DragEvent) => {
        const imgUrl = extractCardImage(card);
        if (!imgUrl) return;
        const payload: CardRefPayload = {
          cardId: card.id,
          imageUrl: imgUrl,
          title: card.title || card.type,
        };
        e.dataTransfer.setData(CARD_REF_MIME, JSON.stringify(payload));
        e.dataTransfer.effectAllowed = "link";
      },
      [card],
    );

    const isPickTarget = useCanvasStore(
      (s) =>
        !!s.pickMode?.active && hasImage && card.id !== s.pickMode.targetCardId,
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
        data-card-id={card.id}
        className="group absolute select-none rounded-xl"
        style={{
          left: card.x,
          top: card.y,
          width: card.width,
          height: card.height,
          zIndex: card.zIndex,
          touchAction: "none",
          contain: "layout style paint",
          boxShadow: selected ? "0 0 14px 3px rgba(129,140,248,0.35), 0 0 4px 1px rgba(56,189,248,0.25)" : "none",
        }}
        onPointerDown={onPointerDown}
        onContextMenu={onContextMenu}
      >
        <div
          className={cn(
            "pointer-events-none absolute rounded-[14px] transition-opacity duration-200",
            selected
              ? "card-selected-border opacity-100"
              : "opacity-[0.35] group-hover:opacity-[0.55]",
          )}
          style={{
            inset: selected ? -3 : -2,
            padding: selected ? 3 : 2,
            background: selected
              ? "linear-gradient(135deg, #38bdf8, #818cf8, #c084fc, #f472b6, #38bdf8)"
              : `linear-gradient(135deg, ${accentColor}, #a855f7, #ec4899)`,
            backgroundSize: selected ? "400% 400%" : undefined,
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
          )}
        >
          <div className="h-full w-full overflow-hidden">{children}</div>

          {hasImage && !card.locked && (
            <div
              draggable
              onDragStart={onRefDragStart}
              title="拖拽到参考图插槽"
              className="absolute bottom-1.5 left-1.5 z-20 flex h-6 w-6 cursor-move items-center justify-center rounded-md bg-black/50 text-white opacity-0 backdrop-blur-sm transition-opacity hover:bg-primary/80 group-hover:opacity-100 active:cursor-grabbing"
              style={{ userSelect: "auto", WebkitUserSelect: "auto" }}
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <GripVertical className="h-3.5 w-3.5" />
            </div>
          )}

          {isPickTarget && (
            <div className="pointer-events-none absolute inset-0 z-10 animate-pulse rounded-xl ring-2 ring-primary ring-offset-2" />
          )}

        </div>

        <Port side="input" cardId={card.id} color={accentColor} />
        <Port side="output" cardId={card.id} color={accentColor} />

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
    prev.card.type === next.card.type &&
    prev.selected === next.selected,
);
