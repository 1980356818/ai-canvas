import { create } from "zustand";

export type SaveStatus = "saved" | "unsaved" | "saving" | "error";
export type AppView = "home" | "canvas";

export interface ToastItem {
  id: string;
  type: "success" | "error" | "info" | "warning";
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  duration: number;
}

interface UIState {
  sidebarVisible: boolean;
  agentPanelVisible: boolean;
  settingsVisible: boolean;
  saveStatus: SaveStatus;
  toasts: ToastItem[];
  contextMenu: {
    visible: boolean;
    x: number;
    y: number;
    target: "canvas" | "card" | "multi";
    targetId?: string;
  };
  appView: AppView;

  toggleSidebar: () => void;
  toggleAgentPanel: () => void;
  toggleSettings: () => void;
  setSaveStatus: (status: SaveStatus) => void;

  addToast: (toast: Omit<ToastItem, "id">) => void;
  removeToast: (id: string) => void;

  showContextMenu: (
    x: number,
    y: number,
    target: "canvas" | "card" | "multi",
    targetId?: string,
  ) => void;
  hideContextMenu: () => void;

  setAppView: (view: AppView) => void;
}

let toastCounter = 0;

export const useUIStore = create<UIState>((set) => ({
  sidebarVisible: true,
  agentPanelVisible: false,
  settingsVisible: false,
  saveStatus: "saved",
  toasts: [],
  contextMenu: { visible: false, x: 0, y: 0, target: "canvas" },
  appView: "home",

  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  toggleAgentPanel: () =>
    set((s) => ({ agentPanelVisible: !s.agentPanelVisible })),
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

  showContextMenu: (x, y, target, targetId) =>
    set({ contextMenu: { visible: true, x, y, target, targetId } }),

  hideContextMenu: () =>
    set((s) => ({
      contextMenu: { ...s.contextMenu, visible: false },
    })),

  setAppView: (view) => set({ appView: view }),
}));
