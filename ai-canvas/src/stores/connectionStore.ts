import { create } from "zustand";

export type { PortSide, Connection, DraftWire, PendingDrop } from "@/types";
import type { Connection, DraftWire, PendingDrop } from "@/types";

/**
 * Lifecycle hooks invoked synchronously from connection mutations so that
 * downstream invariants (e.g. card-data ↔ connection consistency) cannot drift
 * regardless of which call site triggers the change. Registered exactly once
 * by `referenceConsistency.ts` at module load.
 */
export interface ConnectionLifecycleHooks {
  /** Called AFTER one or more connections were removed. */
  onConnectionsRemoved?: (removed: Connection[]) => void;
  /** Called AFTER one or more connections were added. */
  onConnectionsAdded?: (added: Connection[]) => void;
}

let lifecycleHooks: ConnectionLifecycleHooks = {};
export function setConnectionLifecycleHooks(hooks: ConnectionLifecycleHooks) {
  lifecycleHooks = hooks;
}

/**
 * `connectionsVersion` —— 仅在 `connections` Map 的**集合内容**变化时自增
 * （add / remove / setConnections / removeConnectionsForCard / clear）。
 *
 * 订阅"连线列表派生数据"（如 ImageRefSources / ConnectionLayer 视口剔除）
 * 的下游 **必须** 订它，**禁止** 直接 `useConnectionStore((s) => s.connections)`
 * 当作 useMemo deps —— Map 引用每次 add/remove 都新建，比对开销随 N 线性
 * 增长，且 useMemo deps 浅比较会因 Map 引用变更触发完整重算。
 *
 * 例外：`ConnectionLayer` 主组件本身在 render 阶段需要 iterate connections
 * 来生成 <path>，那里订 `s.connections` 是必需的（不是 useMemo deps）。
 *
 * `selectedConnectionId` / `hoveredConnectionId` / `draftWire` / `flowingConnectionIds`
 * 是局部 UI 状态，不影响 connections 集合，不入 connectionsVersion。
 */
interface ConnectionState {
  connections: Map<string, Connection>;
  connectionsVersion: number;
  selectedConnectionId: string | null;
  hoveredConnectionId: string | null;
  draftWire: DraftWire | null;
  pendingDrop: PendingDrop | null;
  flowingConnectionIds: Set<string>;

  setConnections: (list: Connection[]) => void;
  addConnection: (conn: Connection) => void;
  addConnections: (conns: Connection[]) => void;
  removeConnection: (id: string) => void;
  removeConnectionsForCard: (cardId: string) => void;
  getConnectionsByProject: (projectId: string) => Connection[];
  hasConnection: (sourceCardId: string, targetCardId: string) => boolean;
  setSelectedConnectionId: (id: string | null) => void;
  setHoveredConnectionId: (id: string | null) => void;
  setDraftWire: (wire: DraftWire | null) => void;
  setPendingDrop: (drop: PendingDrop | null) => void;
  setFlowingConnectionIds: (ids: Set<string>) => void;
  clear: () => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connections: new Map(),
  connectionsVersion: 0,
  selectedConnectionId: null,
  hoveredConnectionId: null,
  draftWire: null,
  pendingDrop: null,
  flowingConnectionIds: new Set(),

  setConnections: (list) => {
    const prev = get().connections;
    const map = new Map<string, Connection>();
    for (const c of list) map.set(c.id, c);
    set((s) => ({ connections: map, connectionsVersion: s.connectionsVersion + 1 }));

    const removed: Connection[] = [];
    for (const [id, conn] of prev) {
      if (!map.has(id)) removed.push(conn);
    }
    const added: Connection[] = [];
    for (const [id, conn] of map) {
      if (!prev.has(id)) added.push(conn);
    }
    if (removed.length > 0) lifecycleHooks.onConnectionsRemoved?.(removed);
    if (added.length > 0) lifecycleHooks.onConnectionsAdded?.(added);
  },

  addConnection: (conn) => {
    const prev = get().connections;
    if (prev.has(conn.id)) return;
    set((s) => {
      const next = new Map(s.connections);
      next.set(conn.id, conn);
      return { connections: next, connectionsVersion: s.connectionsVersion + 1 };
    });
    lifecycleHooks.onConnectionsAdded?.([conn]);
  },

  // 批量加连线:**一次性**写入并只触发**一次** onConnectionsAdded(携带全部新连线)。
  // 关键于「复制/粘贴一组卡」:逐条 addConnection 会让 onConnectionsAdded 的兜底清理在
  // 「只看到已加入的前几条连线」时,把尚未重建连线的参考图当悬挂引用误删 → 顺序被重建打乱。
  // 批量加保证清理在所有连线就位后只跑一次,参考图/视频原位保留(配合 materialize 的 id 重映射)。
  addConnections: (conns) => {
    const prev = get().connections;
    const toAdd = conns.filter((c) => !prev.has(c.id));
    if (toAdd.length === 0) return;
    set((s) => {
      const next = new Map(s.connections);
      for (const c of toAdd) next.set(c.id, c);
      return { connections: next, connectionsVersion: s.connectionsVersion + 1 };
    });
    lifecycleHooks.onConnectionsAdded?.(toAdd);
  },

  removeConnection: (id) => {
    const removed = get().connections.get(id);
    if (!removed) return;
    set((s) => {
      const next = new Map(s.connections);
      next.delete(id);
      return {
        connections: next,
        connectionsVersion: s.connectionsVersion + 1,
        selectedConnectionId:
          s.selectedConnectionId === id ? null : s.selectedConnectionId,
      };
    });
    lifecycleHooks.onConnectionsRemoved?.([removed]);
  },

  removeConnectionsForCard: (cardId) => {
    const prev = get().connections;
    const removed: Connection[] = [];
    for (const c of prev.values()) {
      if (c.sourceCardId === cardId || c.targetCardId === cardId) {
        removed.push(c);
      }
    }
    if (removed.length === 0) return;
    set((s) => {
      const next = new Map(s.connections);
      for (const c of removed) next.delete(c.id);
      const stillSelected =
        s.selectedConnectionId &&
        removed.some((c) => c.id === s.selectedConnectionId)
          ? null
          : s.selectedConnectionId;
      return {
        connections: next,
        connectionsVersion: s.connectionsVersion + 1,
        selectedConnectionId: stillSelected,
      };
    });
    lifecycleHooks.onConnectionsRemoved?.(removed);
  },

  getConnectionsByProject: (projectId) =>
    Array.from(get().connections.values()).filter(
      (c) => c.projectId === projectId,
    ),

  hasConnection: (sourceCardId, targetCardId) => {
    for (const c of get().connections.values()) {
      if (c.sourceCardId === sourceCardId && c.targetCardId === targetCardId)
        return true;
    }
    return false;
  },

  setSelectedConnectionId: (id) => set({ selectedConnectionId: id }),
  setHoveredConnectionId: (id) => set({ hoveredConnectionId: id }),
  setDraftWire: (wire) => set({ draftWire: wire }),
  setPendingDrop: (drop) => set({ pendingDrop: drop }),
  setFlowingConnectionIds: (ids) => set({ flowingConnectionIds: ids }),
  clear: () =>
    set((s) => ({
      connections: new Map(),
      connectionsVersion: s.connectionsVersion + 1,
      selectedConnectionId: null,
      hoveredConnectionId: null,
      draftWire: null,
      pendingDrop: null,
      flowingConnectionIds: new Set(),
    })),
}));
