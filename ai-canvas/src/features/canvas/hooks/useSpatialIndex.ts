import { useEffect, useRef } from "react";
import { useCardStore } from "@/stores/cardStore";
import { useProjectStore } from "@/stores/projectStore";
import { spatialIndex } from "@/lib/spatial-index";

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

    const unsubCards = useCardStore.subscribe((state, prev) => {
      if (state.cards === prev.cards) return;
      const pid = useProjectStore.getState().currentProjectId;
      if (!pid) return;

      for (const [id, card] of state.cards) {
        if (card.projectId !== pid) continue;
        const prev_ = prev.cards.get(id);
        if (
          !prev_ ||
          prev_.x !== card.x ||
          prev_.y !== card.y ||
          prev_.width !== card.width ||
          prev_.height !== card.height
        ) {
          spatialIndex.upsert(id, card.x, card.y, card.width, card.height);
        }
      }

      for (const id of prev.cards.keys()) {
        if (!state.cards.has(id)) {
          spatialIndex.remove(id);
        }
      }
    });

    const unsubProject = useProjectStore.subscribe((state, prev) => {
      if (state.currentProjectId !== prev.currentProjectId) {
        sync();
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
