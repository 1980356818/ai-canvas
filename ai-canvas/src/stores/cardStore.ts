import { create } from "zustand";

export type { CardType } from "@/shared/types";
import type { CardType } from "@/shared/types";

export interface CanvasCard {
  id: string;
  projectId: string;
  type: CardType;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  locked: boolean;
  collapsed: boolean;
  color?: string;
  title?: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface CardState {
  cards: Map<string, CanvasCard>;
  maxZIndex: number;

  setCards: (cards: CanvasCard[]) => void;
  addCard: (card: CanvasCard) => void;
  removeCard: (id: string) => void;
  updateCard: (id: string, partial: Partial<CanvasCard>) => void;
  bringToFront: (id: string) => void;
  sendToBack: (id: string) => void;
  getCard: (id: string) => CanvasCard | undefined;
  getCardsByProject: (projectId: string) => CanvasCard[];
  clear: () => void;
}

export const useCardStore = create<CardState>((set, get) => ({
  cards: new Map(),
  maxZIndex: 0,

  setCards: (cards) => {
    const map = new Map<string, CanvasCard>();
    let maxZ = 0;
    for (const card of cards) {
      map.set(card.id, card);
      if (card.zIndex > maxZ) maxZ = card.zIndex;
    }
    set({ cards: map, maxZIndex: maxZ });
  },

  addCard: (card) =>
    set((s) => {
      const next = new Map(s.cards);
      next.set(card.id, card);
      return {
        cards: next,
        maxZIndex: Math.max(s.maxZIndex, card.zIndex),
      };
    }),

  removeCard: (id) =>
    set((s) => {
      const next = new Map(s.cards);
      next.delete(id);
      return { cards: next };
    }),

  updateCard: (id, partial) =>
    set((s) => {
      const card = s.cards.get(id);
      if (!card) return s;
      const next = new Map(s.cards);
      next.set(id, { ...card, ...partial, updatedAt: new Date().toISOString() });
      return { cards: next };
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

  clear: () => set({ cards: new Map(), maxZIndex: 0 }),
}));
