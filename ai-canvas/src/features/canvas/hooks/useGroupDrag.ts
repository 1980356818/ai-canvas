import { useCallback } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import { useGroupStore } from "@/stores/groupStore";
import type { CanvasCard } from "@/types";
import { autoSave } from "@/lib/autoSave";
import { recordUpdate } from "@/lib/history";

/**
 * 拖拽组的标题栏移动整组。
 *
 * ─── 与 CardShell 拖拽的关系 ──────────────────────────────────
 * CardShell.onPointerDown 已有"多选拖拽"逻辑 —— 用户在标题栏 click 选中
 * 整组后,拖任意一张卡都能整组移动。但**用户期望**:直接抓标题栏拖也能整
 * 组移动,不需要"先选再拖"两步。本 hook 提供这条直接路径。
 *
 * ─── 实现要点 ──────────────────────────────────────────────────
 *  • 复用 canvasStore.dragOffsets 通道 —— 跟 CardShell 走同一个 store 信号,
 *    ConnectionLayer / Birdview 等下游天然兼容;
 *  • 用 CSS transform imperative 跟手 —— 拖拽帧不写 cardStore 几何,避免
 *    每帧重渲;
 *  • pointer-up 一次性提交:写 cardStore.updateCard(x/y) + history.recordUpdate +
 *    autoSave.markDirty。
 */
export function useGroupTitleDrag(groupId: string) {
  return useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;

      const group = useGroupStore.getState().getGroup(groupId);
      if (!group) return;

      // 没有子卡可拖,直接走 select 语义(由调用方继续处理)
      if (group.cardIds.length === 0) return;

      // 拖之前先把整组卡片选中,与现有"多选 → 拖任意 → 整组动"语义一致
      useCanvasStore.getState().setSelectedCardIds([...group.cardIds]);

      const cardStore = useCardStore.getState();
      const startCards = new Map<
        string,
        { cx: number; cy: number; el: HTMLElement | null }
      >();
      for (const cid of group.cardIds) {
        const c = cardStore.getCard(cid);
        if (!c) continue;
        const el = document.querySelector(
          `[data-card-id="${cid}"]`,
        ) as HTMLElement | null;
        startCards.set(cid, { cx: c.x, cy: c.y, el });
      }
      if (startCards.size === 0) return;

      e.stopPropagation();
      e.preventDefault();

      const titleEl = e.currentTarget as HTMLElement;
      titleEl.setPointerCapture(e.pointerId);

      const pid = e.pointerId;
      const startMx = e.clientX;
      const startMy = e.clientY;
      const zoom = useCanvasStore.getState().viewport.zoom;
      let didDrag = false;

      // 跟 CardShell 一样用 rAF 合并 dragOffsets 写入,稳定 ≤ 60fps
      let pendingFrame = 0;
      let latestOffsets: Map<string, { dx: number; dy: number }> | null = null;
      const flushOffsets = () => {
        pendingFrame = 0;
        if (latestOffsets) {
          useCanvasStore.getState().setDragOffsets(latestOffsets);
          latestOffsets = null;
        }
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        const dx = (ev.clientX - startMx) / zoom;
        const dy = (ev.clientY - startMy) / zoom;
        const screenDx = ev.clientX - startMx;
        const screenDy = ev.clientY - startMy;
        if (Math.abs(screenDx) > 5 || Math.abs(screenDy) > 5) didDrag = true;

        const offsets = new Map<string, { dx: number; dy: number }>();
        for (const [cid, peer] of startCards) {
          if (peer.el) peer.el.style.transform = `translate(${dx}px, ${dy}px)`;
          offsets.set(cid, { dx, dy });
        }
        latestOffsets = offsets;
        if (!pendingFrame) {
          pendingFrame = requestAnimationFrame(flushOffsets);
        }
      };

      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (pendingFrame) {
          cancelAnimationFrame(pendingFrame);
          pendingFrame = 0;
        }

        const dx = (ev.clientX - startMx) / zoom;
        const dy = (ev.clientY - startMy) / zoom;

        // 即使没真正拖动(微小抖动),也把 offsets 清掉,避免残留视觉偏移
        const movedIds = [...startCards.keys()];
        useCanvasStore.getState().clearDragOffsets(movedIds);
        for (const peer of startCards.values()) {
          if (peer.el) peer.el.style.transform = "";
        }

        if (!didDrag) return;

        // 提交到 store + history + autoSave
        for (const [cid, peer] of startCards) {
          const card = cardStore.getCard(cid);
          if (!card) continue;
          const prev: Partial<CanvasCard> = { x: peer.cx, y: peer.cy };
          const after: Partial<CanvasCard> = { x: peer.cx + dx, y: peer.cy + dy };
          recordUpdate(cid, prev);
          cardStore.updateCard(cid, after);
          autoSave.markDirty(cid);
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [groupId],
  );
}
