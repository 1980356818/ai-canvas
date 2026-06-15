import { useCallback } from "react";
import type { RefObject } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import { useGroupStore } from "@/stores/groupStore";
import { computeGroupBounds } from "@/lib/groupBounds";
import { reconcileFrameMembership } from "@/lib/frameMembership";
import { saveGroupsBatch } from "@/platform";
import { groupToRow } from "@/lib/mappers";

/**
 * 拖拽缩放手柄改变 Frame 的存储边界。
 *
 * Frame 容器化:框是真正的容器,用户可拉拽 8 向手柄改变其矩形;矩形一变,
 * 成员(中心点落在框内的卡)随之重算(纳入/排除卡)。
 *
 * 实现要点(与 useGroupTitleDrag 同款,守画布性能契约):
 *   • 拖拽帧只 imperative 改 shell 元素的 left/top/width/height(rAF 合并),
 *     **不写 store、不触发 React 重渲**;成员卡不动(缩放只改框,不搬卡)。
 *   • pointer-up 一次性提交:updateGroup(存储边界) + reconcileFrameMembership(重算成员)
 *     + saveGroupsBatch 落库。
 */
export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** 最小框尺寸(world 单位),防止拉成 0 / 翻转。 */
const MIN_SIZE = 80;

export function useGroupResize(
  groupId: string,
  shellRef: RefObject<HTMLDivElement | null>,
) {
  return useCallback(
    (dir: ResizeDir) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const group = useGroupStore.getState().getGroup(groupId);
      if (!group) return;

      // 当前真实矩形(读存储边界;未回填则外接框)。
      const start = computeGroupBounds(group, useCardStore.getState().cards);
      if (!start) return;

      e.stopPropagation();
      e.preventDefault();

      const handleEl = e.currentTarget as HTMLElement;
      handleEl.setPointerCapture(e.pointerId);
      const pid = e.pointerId;
      const startMx = e.clientX;
      const startMy = e.clientY;
      const zoom = useCanvasStore.getState().viewport.zoom;
      const canvasRoot = document.querySelector("[data-canvas-viewport]");
      let interacting = false;

      let next = { ...start };
      let frame = 0;
      const apply = () => {
        frame = 0;
        const s = shellRef.current;
        if (!s) return;
        s.style.left = `${next.x}px`;
        s.style.top = `${next.y}px`;
        s.style.width = `${next.width}px`;
        s.style.height = `${next.height}px`;
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        const dx = (ev.clientX - startMx) / zoom;
        const dy = (ev.clientY - startMy) / zoom;
        if (
          !interacting &&
          (Math.abs(ev.clientX - startMx) > 2 || Math.abs(ev.clientY - startMy) > 2)
        ) {
          interacting = true;
          canvasRoot?.classList.add("canvas-interacting");
        }

        let { x, y, width, height } = start;
        if (dir.includes("e")) width = Math.max(MIN_SIZE, start.width + dx);
        if (dir.includes("s")) height = Math.max(MIN_SIZE, start.height + dy);
        if (dir.includes("w")) {
          const w = Math.max(MIN_SIZE, start.width - dx);
          x = start.x + (start.width - w);
          width = w;
        }
        if (dir.includes("n")) {
          const h = Math.max(MIN_SIZE, start.height - dy);
          y = start.y + (start.height - h);
          height = h;
        }
        next = { x, y, width, height };
        if (!frame) frame = requestAnimationFrame(apply);
      };

      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
        if (interacting) canvasRoot?.classList.remove("canvas-interacting");

        // 提交存储边界 → 重算成员(缩放纳入/排除卡) → 落库。
        const gs = useGroupStore.getState();
        gs.updateGroup(groupId, {
          x: next.x,
          y: next.y,
          width: next.width,
          height: next.height,
        });
        reconcileFrameMembership(group.projectId);
        const all = gs.getGroupsByProject(group.projectId);
        void saveGroupsBatch(all.map(groupToRow)).catch((err) =>
          console.warn("[useGroupResize] persist failed:", err),
        );
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [groupId, shellRef],
  );
}
