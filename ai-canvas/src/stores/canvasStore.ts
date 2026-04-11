import { create } from "zustand";

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
}

export interface PickModeState {
  active: boolean;
  targetCardId: string;
  slotKey: string;
  onPick: (sourceCardId: string, imageUrl: string) => void;
}

export interface DragOffset {
  dx: number;
  dy: number;
}

interface CanvasState {
  viewport: Viewport;
  selectedCardIds: Set<string>;
  editingCardId: string | null;
  tool: "select" | "pan";
  isDragging: boolean;
  pickMode: PickModeState | null;
  dragOffsets: Map<string, DragOffset>;

  setViewport: (viewport: Partial<Viewport>) => void;
  setTool: (tool: CanvasState["tool"]) => void;
  setSelectedCardIds: (ids: string[]) => void;
  addSelectedCardId: (id: string) => void;
  removeSelectedCardId: (id: string) => void;
  clearSelection: () => void;
  setEditingCardId: (id: string | null) => void;
  setIsDragging: (dragging: boolean) => void;
  setDragOffset: (cardId: string, offset: DragOffset | null) => void;
  setDragOffsets: (offsets: Map<string, DragOffset>) => void;
  clearDragOffsets: (cardIds: string[]) => void;
  enterPickMode: (state: Omit<PickModeState, "active">) => void;
  exitPickMode: () => void;
}

export const lastPointerWorld = { x: 0, y: 0 };

export const useCanvasStore = create<CanvasState>((set) => ({
  viewport: { x: 0, y: 0, zoom: 1, width: 0, height: 0 },
  selectedCardIds: new Set(),
  editingCardId: null,
  tool: "select",
  isDragging: false,
  pickMode: null,
  dragOffsets: new Map(),

  setViewport: (partial) =>
    set((s) => ({ viewport: { ...s.viewport, ...partial } })),

  setTool: (tool) => set({ tool }),

  setSelectedCardIds: (ids) => set({ selectedCardIds: new Set(ids) }),

  addSelectedCardId: (id) =>
    set((s) => {
      if (s.selectedCardIds.has(id)) return s;
      const next = new Set(s.selectedCardIds);
      next.add(id);
      return { selectedCardIds: next };
    }),

  removeSelectedCardId: (id) =>
    set((s) => {
      if (!s.selectedCardIds.has(id)) return s;
      const next = new Set(s.selectedCardIds);
      next.delete(id);
      return { selectedCardIds: next };
    }),

  clearSelection: () => set({ selectedCardIds: new Set(), editingCardId: null }),

  setEditingCardId: (id) => set({ editingCardId: id }),

  setIsDragging: (dragging) => set({ isDragging: dragging }),

  setDragOffset: (cardId, offset) =>
    set((s) => {
      const next = new Map(s.dragOffsets);
      if (offset) next.set(cardId, offset);
      else next.delete(cardId);
      return { dragOffsets: next };
    }),

  setDragOffsets: (offsets) =>
    set((s) => {
      const next = new Map(s.dragOffsets);
      for (const [cardId, offset] of offsets) {
        next.set(cardId, offset);
      }
      return { dragOffsets: next };
    }),

  clearDragOffsets: (cardIds) =>
    set((s) => {
      const next = new Map(s.dragOffsets);
      for (const cardId of cardIds) {
        next.delete(cardId);
      }
      return { dragOffsets: next };
    }),

  enterPickMode: (state) =>
    set({ pickMode: { ...state, active: true } }),

  exitPickMode: () => set({ pickMode: null }),
}));
