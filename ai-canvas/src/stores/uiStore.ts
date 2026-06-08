import { create } from "zustand";

export type { SaveStatus, AppView, CardGenSubProgress, CardGenProgress, ToastItem } from "@/types";
import type { SaveStatus, AppView, CardGenProgress, ToastItem } from "@/types";

export interface CropDialogState {
  open: boolean;
  imageUrl: string;
  displayUrl: string;
  cardId: string;
}

interface UIState {
  sidebarVisible: boolean;
  agentPanelVisible: boolean;
  chatPanelVisible: boolean;
  taskRecordVisible: boolean;
  settingsVisible: boolean;
  priceListVisible: boolean;
  saveStatus: SaveStatus;
  toasts: ToastItem[];
  contextMenu: {
    visible: boolean;
    x: number;
    y: number;
    target: "canvas" | "card" | "multi" | "connection" | "group";
    targetId?: string;
    worldX?: number;
    worldY?: number;
  };
  cropDialog: CropDialogState;
  appView: AppView;
  generatingCards: Map<string, CardGenProgress>;
  cardErrors: Map<string, string>;
  /**
   * 正在重命名中的组 id。GroupLayer 的标题栏 span 监听它,匹配时切换为 contentEditable。
   * 双击标题、右键菜单"重命名"、键盘 F2(M+) 都走这条统一通道。
   */
  editingGroupId: string | null;
  /** 升级弹窗：非 null 时打开；"" = 默认文案，字符串 = 上下文原因（如"该模板需要正式版"） */
  upgradeReason: string | null;

  toggleSidebar: () => void;
  toggleAgentPanel: () => void;
  toggleChatPanel: () => void;
  toggleTaskRecord: () => void;
  toggleSettings: () => void;
  togglePriceList: () => void;
  setSaveStatus: (status: SaveStatus) => void;

  addToast: (toast: Omit<ToastItem, "id">) => void;
  removeToast: (id: string) => void;

  showContextMenu: (
    x: number,
    y: number,
    target: "canvas" | "card" | "multi" | "connection" | "group",
    targetId?: string,
    worldX?: number,
    worldY?: number,
  ) => void;
  hideContextMenu: () => void;

  openCropDialog: (imageUrl: string, displayUrl: string, cardId: string) => void;
  closeCropDialog: () => void;

  setAppView: (view: AppView) => void;
  setCardProgress: (cardId: string, progress: CardGenProgress | null) => void;
  setCardError: (cardId: string, error: string | null) => void;
  setEditingGroupId: (groupId: string | null) => void;
  openUpgrade: (reason?: string) => void;
  closeUpgrade: () => void;
}

let toastCounter = 0;

export const useUIStore = create<UIState>((set) => ({
  sidebarVisible: false,
  agentPanelVisible: false,
  chatPanelVisible: false,
  taskRecordVisible: false,
  settingsVisible: false,
  priceListVisible: false,
  saveStatus: "saved",
  toasts: [],
  contextMenu: { visible: false, x: 0, y: 0, target: "canvas" },
  cropDialog: { open: false, imageUrl: "", displayUrl: "", cardId: "" },
  appView: "home",
  generatingCards: new Map(),
  cardErrors: new Map(),
  editingGroupId: null,
  upgradeReason: null,

  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  toggleAgentPanel: () =>
    set((s) => ({ agentPanelVisible: !s.agentPanelVisible })),
  toggleChatPanel: () =>
    set((s) => ({
      chatPanelVisible: !s.chatPanelVisible,
      agentPanelVisible: !s.chatPanelVisible ? false : s.agentPanelVisible,
    })),
  toggleTaskRecord: () =>
    set((s) => ({ taskRecordVisible: !s.taskRecordVisible })),
  toggleSettings: () =>
    set((s) => ({ settingsVisible: !s.settingsVisible })),
  togglePriceList: () =>
    set((s) => ({ priceListVisible: !s.priceListVisible })),
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

  openCropDialog: (imageUrl, displayUrl, cardId) =>
    set({ cropDialog: { open: true, imageUrl, displayUrl, cardId } }),

  closeCropDialog: () =>
    set({ cropDialog: { open: false, imageUrl: "", displayUrl: "", cardId: "" } }),

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

  setEditingGroupId: (groupId) =>
    set((s) => (s.editingGroupId === groupId ? s : { editingGroupId: groupId })),

  openUpgrade: (reason) => set({ upgradeReason: reason ?? "" }),
  closeUpgrade: () => set({ upgradeReason: null }),
}));

/**
 * 单卡"是否在生成中"的**单一真相** selector。
 *
 * `generatingCards` 是经 `setCardProgress` 维护的唯一"生成中"集合,所有生成
 * 路径都汇到它:
 *   - 编辑器手点:handleGenerate 自己 set / 清;
 *   - 组运行 / agent / 重试:cardRunner.runCard 进入即 set 占位、finally 清;
 *   - task 轮询期:taskBridge 持续 set 进度、终态清。
 * 所以判断"某张卡在不在生成"**只看这一个集合**即可 —— 不必再 OR
 * groupRunStatus.currentCardIds / task.status 等来源(那是旧的状态分裂根源)。
 *
 * 返回 boolean primitive,Object.is 比较稳定,工厂每次新建闭包无碍。
 */
export const selectCardBusy = (cardId: string) => (s: UIState) =>
  s.generatingCards.has(cardId);
