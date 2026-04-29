import { create } from "zustand";

export type { CardType, CanvasCard } from "@/types";
import type { CanvasCard } from "@/types";

interface CardState {
  cards: Map<string, CanvasCard>;
  maxZIndex: number;
  layoutVersion: number;

  setCards: (cards: CanvasCard[]) => void;
  addCard: (card: CanvasCard) => void;
  removeCard: (id: string) => void;
  updateCard: (id: string, partial: Partial<CanvasCard>) => void;
  /**
   * Atomically shallow-merge `dataPatch` into the LATEST card.data in the
   * store. Use this in editors instead of `updateCard({ data: { ...data, ...patch } })`
   * to avoid stale-closure overwrites (e.g. when reference-cleanup runs between
   * render and click). Fields whose value is `undefined` are removed.
   */
  updateCardData: (id: string, dataPatch: Record<string, unknown>) => void;
  bringToFront: (id: string) => void;
  sendToBack: (id: string) => void;
  getCard: (id: string) => CanvasCard | undefined;
  getCardsByProject: (projectId: string) => CanvasCard[];
  clear: () => void;
}

export const useCardStore = create<CardState>((set, get) => ({
  cards: new Map(),
  maxZIndex: 0,
  layoutVersion: 0,

  setCards: (cards) => {
    const map = new Map<string, CanvasCard>();
    let maxZ = 0;
    for (const card of cards) {
      map.set(card.id, card);
      if (card.zIndex > maxZ) maxZ = card.zIndex;
    }
    set((s) => ({ cards: map, maxZIndex: maxZ, layoutVersion: s.layoutVersion + 1 }));
  },

  addCard: (card) =>
    set((s) => {
      const next = new Map(s.cards);
      next.set(card.id, card);
      return {
        cards: next,
        maxZIndex: Math.max(s.maxZIndex, card.zIndex),
        layoutVersion: s.layoutVersion + 1,
      };
    }),

  removeCard: (id) =>
    set((s) => {
      const next = new Map(s.cards);
      next.delete(id);
      return { cards: next, layoutVersion: s.layoutVersion + 1 };
    }),

  updateCard: (id, partial) =>
    set((s) => {
      const card = s.cards.get(id);
      if (!card) return s;
      const next = new Map(s.cards);
      const updated = { ...card, ...partial, updatedAt: new Date().toISOString() };
      next.set(id, updated);
      const layoutChanged =
        updated.x !== card.x ||
        updated.y !== card.y ||
        updated.width !== card.width ||
        updated.height !== card.height;
      return {
        cards: next,
        layoutVersion: layoutChanged ? s.layoutVersion + 1 : s.layoutVersion,
      };
    }),

  updateCardData: (id, dataPatch) =>
    set((s) => {
      const card = s.cards.get(id);
      if (!card) return s;
      const currentData = (card.data ?? {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...currentData };
      let changed = false;
      for (const key of Object.keys(dataPatch)) {
        const next = dataPatch[key];
        if (next === undefined) {
          if (key in merged) {
            delete merged[key];
            changed = true;
          }
        } else if (merged[key] !== next) {
          merged[key] = next;
          changed = true;
        }
      }
      if (!changed) return s;
      const nextCards = new Map(s.cards);
      nextCards.set(id, { ...card, data: merged, updatedAt: new Date().toISOString() });
      return { cards: nextCards };
    }),

  bringToFront: (id) =>
    set((s) => {
      const card = s.cards.get(id);
      if (!card) return s;
      const newZ = s.maxZIndex + 1;
      const next = new Map(s.cards);
      next.set(id, { ...card, zIndex: newZ });
      return { cards: next, maxZIndex: newZ };
    }),

  sendToBack: (id) =>
    set((s) => {
      const card = s.cards.get(id);
      if (!card) return s;
      let minZ = Infinity;
      for (const c of s.cards.values()) {
        if (c.zIndex < minZ) minZ = c.zIndex;
      }
      const next = new Map(s.cards);
      next.set(id, { ...card, zIndex: minZ - 1 });
      return { cards: next };
    }),

  getCard: (id) => get().cards.get(id),

  getCardsByProject: (projectId) =>
    Array.from(get().cards.values()).filter((c) => c.projectId === projectId),

  clear: () => set((s) => ({ cards: new Map(), maxZIndex: 0, layoutVersion: s.layoutVersion + 1 })),
}));
