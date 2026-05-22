import { useEffect, useRef } from "react";
import { useCardStore } from "@/stores/cardStore";
import { useProjectStore } from "@/stores/projectStore";
import { spatialIndex } from "@/lib/spatial-index";

/**
 * 同步 cardStore 与 rbush 空间索引。
 *
 * 仅在 `layoutVersion` 变化时跑 diff —— `updateCardData`（编辑器改 prompt、
 * 改 imageUrl 等非几何字段）不会触发空间索引同步。
 *
 * 历史教训：旧实现订阅整个 `cards` Map（`state.cards !== prev.cards` 即跑
 * O(N) diff），但 cardStore 任何 mutation 都会复制出新 Map → 永远不相等
 * → 拖动一张卡 60fps × O(N) 比对，2000+ 张卡片时显著卡顿。
 */
export function useSpatialIndex() {
  const initialized = useRef(false);

  useEffect(() => {
    const sync = () => {
      const pid = useProjectStore.getState().currentProjectId;
      const cards = useCardStore.getState().cards;
      spatialIndex.clear();
      if (!pid) return;
      for (const card of cards.values()) {
        if (card.projectId === pid) {
          spatialIndex.upsert(card.id, card.x, card.y, card.width, card.height);
        }
      }
      initialized.current = true;
    };

    sync();

    // 上次跑 diff 时见过的 layoutVersion / cards 引用；
    // 用闭包 ref 而不是 React ref，避免 effect 依赖数组带来的重订阅。
    let lastLayoutVersion = useCardStore.getState().layoutVersion;
    let lastCardsSnapshot: Map<string, { x: number; y: number; w: number; h: number; pid: string }> =
      snapshotGeom(useCardStore.getState().cards);

    const unsubCards = useCardStore.subscribe((state) => {
      // 跳过非 layout 变更 —— updateCardData 等不会改 layoutVersion
      if (state.layoutVersion === lastLayoutVersion) return;
      lastLayoutVersion = state.layoutVersion;

      const pid = useProjectStore.getState().currentProjectId;
      if (!pid) {
        lastCardsSnapshot = snapshotGeom(state.cards);
        return;
      }

      const nextSnap = snapshotGeom(state.cards);

      // 增 / 改：当前快照里有，且 (新增 || 几何不同) → upsert
      for (const [id, geom] of nextSnap) {
        if (geom.pid !== pid) continue;
        const prev = lastCardsSnapshot.get(id);
        if (
          !prev ||
          prev.x !== geom.x ||
          prev.y !== geom.y ||
          prev.w !== geom.w ||
          prev.h !== geom.h
        ) {
          spatialIndex.upsert(id, geom.x, geom.y, geom.w, geom.h);
        }
      }

      // 删：上次有的本次没了
      for (const id of lastCardsSnapshot.keys()) {
        if (!nextSnap.has(id)) {
          spatialIndex.remove(id);
        }
      }

      lastCardsSnapshot = nextSnap;
    });

    const unsubProject = useProjectStore.subscribe((state, prev) => {
      if (state.currentProjectId !== prev.currentProjectId) {
        sync();
        // 切项目后重设 baseline，避免下次 layoutVersion diff 拿旧项目的卡比
        lastLayoutVersion = useCardStore.getState().layoutVersion;
        lastCardsSnapshot = snapshotGeom(useCardStore.getState().cards);
      }
    });

    return () => {
      unsubCards();
      unsubProject();
      spatialIndex.clear();
    };
  }, []);

  return spatialIndex;
}

/**
 * 给空间索引做的"扁平几何快照"——只保留 diff 用得到的字段（x/y/w/h/pid），
 * 避免在 hot path 上 hold 整个 CanvasCard 引用（防止意外延寿）。
 */
function snapshotGeom(
  cards: Map<string, { id: string; x: number; y: number; width: number; height: number; projectId: string }>,
): Map<string, { x: number; y: number; w: number; h: number; pid: string }> {
  const out = new Map<string, { x: number; y: number; w: number; h: number; pid: string }>();
  for (const c of cards.values()) {
    out.set(c.id, { x: c.x, y: c.y, w: c.width, h: c.height, pid: c.projectId });
  }
  return out;
}
