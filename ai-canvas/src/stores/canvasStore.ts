import { create } from "zustand";

export type { Viewport, PickModeState, DragOffset } from "@/types";
import type { Viewport, PickModeState, DragOffset } from "@/types";

interface CanvasState {
  viewport: Viewport;
  selectedCardIds: Set<string>;
  editingCardId: string | null;
  tool: "select" | "pan";
  isDragging: boolean;
  pickMode: PickModeState | null;
  dragOffsets: Map<string, DragOffset>;
  /**
   * 视频卡的拖帧模式 — 非 null 时, 该卡片进入"挑帧"焦点模式:
   *   - FloatingEditor 隐藏 (把卡下方空间让给时间轴)
   *   - VideoToolbar 渲染 TimelineScrubber + FrameChip
   *   - 用户可连续拖帧到画布, 不会触发 editor 弹出
   * 设计动机见 docs (本提交): 挑帧 vs 放帧两阶段, scrubber 走剪辑软件惯例。
   */
  scrubberActiveCardId: string | null;
  /**
   * 拖卡时"悬停在哪个组上方"的候选 id。
   *   - 拖卡 onMove 时由 CardShell 写;
   *   - GroupLayer 订阅它给该组矩形换实线+浓边框,提示"放手即加入";
   *   - 拖卡结束(pointerup)由 CardShell 写 null 清除。
   *
   * 不属于 dragOffsets 通道:dragOffsets 是 60fps 的几何流,version 频繁 bump 会
   * 让所有订阅它的组件抖动;hoverGroupId 仅在跨越组边界时才变,适合走独立 selector。
   */
  hoverGroupId: string | null;

  /**
   * 「剪切待移动」的卡片 id 集合(延迟删除语义,仿 Windows 资源管理器剪文件)。
   *   - Ctrl+X / 右键剪切时写入:卡片**不删除**,只打虚化标记 + 写剪贴板快照。
   *   - 下次粘贴时:在落点重建这些卡 + 删除原卡(= 移动),然后清空本集合。
   *   - 复制别的内容 / 再剪别的 / Esc / 删除 → 清空本集合(取消剪切),原卡始终在画布上。
   * 这样「剪切后又复制别的东西」绝不会丢卡 —— 原卡从未离开画布,直到一次成功粘贴。
   */
  cutCardIds: Set<string>;
  /** 剪切发生时所在项目 id —— 跨项目粘贴(移动)后用来同步源项目 nodeCount。 */
  cutSourceProjectId: string | null;

  setViewport: (viewport: Partial<Viewport>) => void;
  setTool: (tool: CanvasState["tool"]) => void;
  setSelectedCardIds: (ids: string[]) => void;
  addSelectedCardId: (id: string) => void;
  removeSelectedCardId: (id: string) => void;
  clearSelection: () => void;
  setEditingCardId: (id: string | null) => void;
  setScrubberActiveCardId: (id: string | null) => void;
  setIsDragging: (dragging: boolean) => void;
  setDragOffset: (cardId: string, offset: DragOffset | null) => void;
  setDragOffsets: (offsets: Map<string, DragOffset>) => void;
  clearDragOffsets: (cardIds: string[]) => void;
  setHoverGroupId: (groupId: string | null) => void;
  setCutCards: (ids: string[], projectId: string) => void;
  clearCutCards: () => void;
  enterPickMode: (state: Omit<PickModeState, "active">) => void;
  exitPickMode: () => void;
}

export const lastPointerWorld = { x: 0, y: 0 };

// 实时 viewport 共享对象。useViewport 在拖拽/滚轮路径上会 60fps 更新此对象（绕开 React），
// store viewport 在节流提交时同步过来。浮层组件（FloatingEditor / ImageToolbar 等）
// 通过 subscribeViewport 注册回调，imperative 更新自身位置而无需触发 React 重渲染。
export const liveViewport = { x: 0, y: 0, zoom: 1 };
const viewportSubs = new Set<() => void>();

export function notifyViewportChanged() {
  for (const cb of viewportSubs) cb();
}

export function subscribeViewport(cb: () => void): () => void {
  viewportSubs.add(cb);
  return () => {
    viewportSubs.delete(cb);
  };
}

export const useCanvasStore = create<CanvasState>((set) => ({
  viewport: { x: 0, y: 0, zoom: 1, width: 0, height: 0 },
  selectedCardIds: new Set(),
  editingCardId: null,
  tool: "select",
  isDragging: false,
  pickMode: null,
  dragOffsets: new Map(),
  scrubberActiveCardId: null,
  hoverGroupId: null,
  cutCardIds: new Set(),
  cutSourceProjectId: null,

  setViewport: (partial) =>
    set((s) => {
      const next = { ...s.viewport, ...partial };
      // 同步 imperative 共享对象 + 通知订阅者，覆盖 fitAll / zoomTo 等非拖拽路径
      liveViewport.x = next.x;
      liveViewport.y = next.y;
      liveViewport.zoom = next.zoom;
      notifyViewportChanged();
      return { viewport: next };
    }),

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

  setScrubberActiveCardId: (id) => set({ scrubberActiveCardId: id }),

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

  setHoverGroupId: (groupId) =>
    set((s) => (s.hoverGroupId === groupId ? s : { hoverGroupId: groupId })),

  setCutCards: (ids, projectId) =>
    set({ cutCardIds: new Set(ids), cutSourceProjectId: projectId }),

  clearCutCards: () =>
    set((s) =>
      s.cutCardIds.size === 0 && s.cutSourceProjectId === null
        ? s
        : { cutCardIds: new Set(), cutSourceProjectId: null },
    ),

  enterPickMode: (state) =>
    set({ pickMode: { ...state, active: true } }),

  exitPickMode: () => set({ pickMode: null }),
}));
