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

interface ConnectionState {
  connections: Map<string, Connection>;
  selectedConnectionId: string | null;
  hoveredConnectionId: string | null;
  draftWire: DraftWire | null;
  pendingDrop: PendingDrop | null;
  flowingConnectionIds: Set<string>;

  setConnections: (list: Connection[]) => void;
  addConnection: (conn: Connection) => void;
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
  selectedConnectionId: null,
  hoveredConnectionId: null,
  draftWire: null,
  pendingDrop: null,
  flowingConnectionIds: new Set(),

  setConnections: (list) => {
    const prev = get().connections;
    const map = new Map<string, Connection>();
    for (const c of list) map.set(c.id, c);
    set({ connections: map });

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
      return { connections: next };
    });
    lifecycleHooks.onConnectionsAdded?.([conn]);
  },

  removeConnection: (id) => {
    const removed = get().connections.get(id);
    if (!removed) return;
    set((s) => {
      const next = new Map(s.connections);
      next.delete(id);
      return {
        connections: next,
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
      return { connections: next, selectedConnectionId: stillSelected };
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
    set({
      connections: new Map(),
      selectedConnectionId: null,
      hoveredConnectionId: null,
      draftWire: null,
      pendingDrop: null,
      flowingConnectionIds: new Set(),
    }),
}));
