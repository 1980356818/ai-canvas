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

interface CanvasState {
  viewport: Viewport;
  selectedCardIds: Set<string>;
  editingCardId: string | null;
  tool: "select" | "pan";
  isDragging: boolean;
  pickMode: PickModeState | null;

  setViewport: (viewport: Partial<Viewport>) => void;
  setTool: (tool: CanvasState["tool"]) => void;
  setSelectedCardIds: (ids: string[]) => void;
  addSelectedCardId: (id: string) => void;
  removeSelectedCardId: (id: string) => void;
  clearSelection: () => void;
  setEditingCardId: (id: string | null) => void;
  setIsDragging: (dragging: boolean) => void;
  enterPickMode: (state: Omit<PickModeState, "active">) => void;
  exitPickMode: () => void;
}

export const useCanvasStore = create<CanvasState>((set) => ({
  viewport: { x: 0, y: 0, zoom: 1, width: 0, height: 0 },
  selectedCardIds: new Set(),
  editingCardId: null,
  tool: "select",
  isDragging: false,
  pickMode: null,

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

  enterPickMode: (state) =>
    set({ pickMode: { ...state, active: true } }),

  exitPickMode: () => set({ pickMode: null }),
}));
