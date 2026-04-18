import { create } from "zustand";

export type { SaveStatus, AppView, CardGenSubProgress, CardGenProgress, ToastItem } from "@/types";
import type { SaveStatus, AppView, CardGenProgress, ToastItem } from "@/types";

interface UIState {
  sidebarVisible: boolean;
  agentPanelVisible: boolean;
  chatPanelVisible: boolean;
  settingsVisible: boolean;
  saveStatus: SaveStatus;
  toasts: ToastItem[];
  contextMenu: {
    visible: boolean;
    x: number;
    y: number;
    target: "canvas" | "card" | "multi" | "connection";
    targetId?: string;
    worldX?: number;
    worldY?: number;
  };
  appView: AppView;
  generatingCards: Map<string, CardGenProgress>;
  cardErrors: Map<string, string>;

  toggleSidebar: () => void;
  toggleAgentPanel: () => void;
  toggleChatPanel: () => void;
  toggleSettings: () => void;
  setSaveStatus: (status: SaveStatus) => void;

  addToast: (toast: Omit<ToastItem, "id">) => void;
  removeToast: (id: string) => void;

  showContextMenu: (
    x: number,
    y: number,
    target: "canvas" | "card" | "multi" | "connection",
    targetId?: string,
    worldX?: number,
    worldY?: number,
  ) => void;
  hideContextMenu: () => void;

  setAppView: (view: AppView) => void;
  setCardProgress: (cardId: string, progress: CardGenProgress | null) => void;
  setCardError: (cardId: string, error: string | null) => void;
}

let toastCounter = 0;

export const useUIStore = create<UIState>((set) => ({
  sidebarVisible: false,
  agentPanelVisible: false,
  chatPanelVisible: false,
  settingsVisible: false,
  saveStatus: "saved",
  toasts: [],
  contextMenu: { visible: false, x: 0, y: 0, target: "canvas" },
  appView: "home",
  generatingCards: new Map(),
  cardErrors: new Map(),

  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  toggleAgentPanel: () =>
    set((s) => ({ agentPanelVisible: !s.agentPanelVisible })),
  toggleChatPanel: () =>
    set((s) => ({
      chatPanelVisible: !s.chatPanelVisible,
      agentPanelVisible: !s.chatPanelVisible ? false : s.agentPanelVisible,
    })),
  toggleSettings: () =>
    set((s) => ({ settingsVisible: !s.settingsVisible })),
  setSaveStatus: (status) => set({ saveStatus: status }),

  addToast: (toast) => {
    const id = `toast-${++toastCounter}`;
    set((s) => ({
      toasts: [...s.toasts.slice(-2), { ...toast, id }],
    }));
    if (toast.duration > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, toast.duration);
    }
  },

  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  showContextMenu: (x, y, target, targetId, worldX, worldY) =>
    set({ contextMenu: { visible: true, x, y, target, targetId, worldX, worldY } }),

  hideContextMenu: () =>
    set((s) => ({
      contextMenu: { ...s.contextMenu, visible: false },
    })),

  setAppView: (view) => set({ appView: view }),

  setCardProgress: (cardId, progress) =>
    set((s) => {
      const next = new Map(s.generatingCards);
      if (progress) next.set(cardId, progress);
      else next.delete(cardId);
      return { generatingCards: next };
    }),

  setCardError: (cardId, error) =>
    set((s) => {
      const next = new Map(s.cardErrors);
      if (error) next.set(cardId, error);
      else next.delete(cardId);
      return { cardErrors: next };
    }),
}));
