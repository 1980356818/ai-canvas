import { useRef, useCallback, useState, memo } from "react";
import { GripVertical } from "lucide-react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard, Connection } from "@/types";
import { useUIStore } from "@/stores/uiStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProjectStore } from "@/stores/projectStore";
import { autoSave } from "@/lib/autoSave";
import { recordUpdate } from "@/lib/history";
import { cn, hexAlpha } from "@/lib/utils";
import { TYPE_COLORS, sizeFromRatio } from "@/shared/constants";
import {
  cardHasImage,
  extractCardImage,
  CARD_REF_MIME,
  type CardRefPayload,
} from "@/config/model-ref-images";
import {
  canAcceptConnection,
} from "@/lib/dataFlow";
import CardLabel from "./CardLabel";

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
  for (const el of els) {
    const cardEl = el.closest("[data-card-id]") as HTMLElement | null;
    if (cardEl && cardEl.dataset.cardId !== excludeCardId) {
      const port = cardEl.querySelector("[data-port-input]") as HTMLElement | null;
      if (port) return port;
    }
  }
  return null;
}

const Port = memo(function Port({
  side,
  cardId,
  color,
  inset = 0,
}: {
  side: "input" | "output";
  cardId: string;
  color: string;
  inset?: number;
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

        const wire = useConnectionStore.getState().draftWire;
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
            const reject = canAcceptConnection(targetCardId, cardId);
            if (reject !== true) {
              useUIStore.getState().addToast({
                type: "warning",
                title: reject.title,
                description: reject.description,
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
          }
        } else if (wire) {
          const vp = useCanvasStore.getState().viewport;
          const root = document.querySelector("[data-canvas-viewport]");
          const rect = root?.getBoundingClientRect();
          const left = rect?.left ?? 0;
          const top = rect?.top ?? 0;
          useConnectionStore.getState().setPendingDrop({
            sourceCardId: cardId,
            screenX: ev.clientX,
            screenY: ev.clientY,
            canvasX: (ev.clientX - left - vp.x) / vp.zoom,
            canvasY: (ev.clientY - top - vp.y) / vp.zoom,
          });
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
        isOutput ? "translate-x-1/2" : "-translate-x-1/2",
        isDraftTarget && "scale-[1.4]",
      )}
      style={{ [isOutput ? 'right' : 'left']: inset }}
      onPointerDown={onPortPointerDown}
    >
      <div
        className="absolute inset-[-1px] rounded-full"
        aria-hidden
      />
      <div
        className={cn(
          "port-socket relative flex items-center justify-center rounded-full",
          "h-[18px] w-[18px] transition-all duration-150",
          isOutput ? "cursor-crosshair" : "cursor-default",
          isDraftTarget && "animate-pulse",
        )}
        style={{
          border: `2px solid ${color}`,
          borderColor: isDraftTarget ? color : hexAlpha(color, 0.55),
          background: isDraftTarget
            ? hexAlpha(color, 0.25)
            : hexAlpha(color, 0.08),
          boxShadow: isDraftTarget
            ? `0 0 12px ${hexAlpha(color, 0.53)}, inset 0 1px 3px rgba(0,0,0,0.2)`
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

        // 边距点击退出 textarea 编辑：textarea 内部的 pointerdown 已 stopPropagation，
        // 所以这里收到的全是"边距/卡片其他区域"事件，主动 blur 让 Delete 等键的语义
        // 切换到"操作卡片"。
        const active = document.activeElement;
        if (
          active instanceof HTMLElement &&
          (active.tagName === "INPUT" ||
            active.tagName === "TEXTAREA" ||
            active.isContentEditable)
        ) {
          active.blur();
        }

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
          if (belowCard.type === "ai_image" || belowCard.type === "ai_multiangle") {
            return cardBelow;
          }
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
        if (!selectedIds.has(card.id) && !e.ctrlKey && !e.metaKey) {
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

        // 拖动期间 store 写入用 rAF 合并：原生 pointermove 在高刷屏可达 120fps，
        // 每次都直接 setDragOffsets 会推动 ConnectionLayer / CanvasBirdView 重渲染。
        // 用一个 pendingFrame 把同帧多次更新合并成一次提交，稳定 ≤60fps。
        let pendingFrame = 0;
        let latestGroupOffsets: Map<string, { dx: number; dy: number }> | null = null;
        let latestSingleOffset: { dx: number; dy: number } | null = null;
        const flushDragOffsets = () => {
          pendingFrame = 0;
          const store = useCanvasStore.getState();
          if (latestGroupOffsets) {
            store.setDragOffsets(latestGroupOffsets);
            latestGroupOffsets = null;
          } else if (latestSingleOffset) {
            store.setDragOffset(card.id, latestSingleOffset);
            latestSingleOffset = null;
          }
        };

        const onMove = (ev: PointerEvent) => {
          if (ev.pointerId !== pid || !dragging.current) return;
          const dx = (ev.clientX - dragStart.current.mx) / zoom;
          const dy = (ev.clientY - dragStart.current.my) / zoom;
          const screenDx = ev.clientX - dragStart.current.mx;
          const screenDy = ev.clientY - dragStart.current.my;
          if (Math.abs(screenDx) > 5 || Math.abs(screenDy) > 5) didDrag.current = true;
          // DOM transform 立刻 imperative 更新，跟手手感不受 rAF 节流影响
          el.style.transform = `translate(${dx}px, ${dy}px)`;

          if (isGroupDrag) {
            const offsets = new Map<string, { dx: number; dy: number }>();
            offsets.set(card.id, { dx, dy });
            for (const [sid, peer] of peerStarts) {
              if (peer.el) peer.el.style.transform = `translate(${dx}px, ${dy}px)`;
              offsets.set(sid, { dx, dy });
            }
            latestGroupOffsets = offsets;
            latestSingleOffset = null;
          } else {
            latestSingleOffset = { dx, dy };
            latestGroupOffsets = null;
          }
          if (!pendingFrame) {
            pendingFrame = requestAnimationFrame(flushDragOffsets);
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
          el.removeEventListener("pointermove", onMove);
          el.removeEventListener("pointerup", onUp);
          el.removeEventListener("lostpointercapture", onUp);

          // 取消任何 pending rAF 提交，避免在 clearDragOffsets 之后再写入残留 offset
          if (pendingFrame) {
            cancelAnimationFrame(pendingFrame);
            pendingFrame = 0;
          }
          latestGroupOffsets = null;
          latestSingleOffset = null;

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
                  if (target.type === "ai_image" || target.type === "ai_multiangle") {
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

            if (!ev.ctrlKey && !ev.metaKey && !isGroupDrag) {
              useCanvasStore.getState().setSelectedCardIds([card.id]);
            }
          } else {
            const pm = useCanvasStore.getState().pickMode;
            if (pm?.active) {
              const imgUrl = extractCardImage(card);
              if (imgUrl) pm.onPick(card.id, imgUrl);
            } else if (ev.ctrlKey || ev.metaKey) {
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
        const { selectedCardIds } = useCanvasStore.getState();
        if (selectedCardIds.has(card.id) && selectedCardIds.size > 1) {
          showContextMenu(e.clientX, e.clientY, "multi", card.id);
        } else {
          useCanvasStore.getState().setSelectedCardIds([card.id]);
          showContextMenu(e.clientX, e.clientY, "card", card.id);
        }
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
          contain: "layout style",
          boxShadow: selected ? "0 0 14px 3px rgba(129,140,248,0.35), 0 0 4px 1px rgba(56,189,248,0.25)" : "none",
        }}
        onPointerDown={onPointerDown}
        onContextMenu={onContextMenu}
      >
        <div className="relative h-full w-full overflow-hidden rounded-xl">
          <div
            className={cn(
              "pointer-events-none absolute transition-opacity duration-200",
              selected
                ? "card-selected-border opacity-100"
                : "opacity-[0.35] group-hover:opacity-[0.55]",
            )}
            style={{
              inset: 0,
              padding: selected ? 3 : 2,
              borderRadius: 'inherit',
              zIndex: 10,
              background: selected
                ? "linear-gradient(135deg, #38bdf8, #818cf8, #c084fc, #f472b6, #38bdf8)"
                : `linear-gradient(135deg, ${accentColor}, #a855f7, #ec4899)`,
              backgroundSize: selected ? "400% 400%" : undefined,
              WebkitMask:
                "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
              WebkitMaskComposite: "xor",
            }}
          />

          <div
            className={cn(
              "relative h-full w-full overflow-hidden rounded-xl bg-card transition-shadow",
              selected ? "shadow-lg dark:shadow-[0_4px_24px_rgba(0,0,0,0.6)]" : "shadow-sm group-hover:shadow-md dark:shadow-[0_2px_8px_rgba(0,0,0,0.5)] dark:group-hover:shadow-[0_4px_16px_rgba(0,0,0,0.6)]",
              card.locked && "cursor-not-allowed opacity-90",
              resizing && "transition-none",
            )}
          >
            <div className="h-full w-full">{children}</div>

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
        </div>

        {(card.data as { _showLabel?: boolean })?._showLabel && (
          <CardLabel card={card} />
        )}

        <Port side="input" cardId={card.id} color={accentColor} inset={selected ? 1.5 : 1} />
        <Port side="output" cardId={card.id} color={accentColor} inset={selected ? 1.5 : 1} />

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
    prev.card.title === next.card.title &&
    (prev.card.data as { _showLabel?: boolean })?._showLabel ===
      (next.card.data as { _showLabel?: boolean })?._showLabel &&
    prev.selected === next.selected,
);
