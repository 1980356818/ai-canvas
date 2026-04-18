import { create } from "zustand";

export type { PortSide, Connection, DraftWire, PendingDrop } from "@/types";
import type { Connection, DraftWire, PendingDrop } from "@/types";

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
    const map = new Map<string, Connection>();
    for (const c of list) map.set(c.id, c);
    set({ connections: map });
  },

  addConnection: (conn) =>
    set((s) => {
      const next = new Map(s.connections);
      next.set(conn.id, conn);
      return { connections: next };
    }),

  removeConnection: (id) =>
    set((s) => {
      const next = new Map(s.connections);
      next.delete(id);
      return {
        connections: next,
        selectedConnectionId:
          s.selectedConnectionId === id ? null : s.selectedConnectionId,
      };
    }),

  removeConnectionsForCard: (cardId) =>
    set((s) => {
      const next = new Map(s.connections);
      for (const [id, c] of next) {
        if (c.sourceCardId === cardId || c.targetCardId === cardId) {
          next.delete(id);
        }
      }
      return { connections: next };
    }),

  getConnectionsByProject: (projectId) =>
    Array.from(get().connections.values()).filter(
      (c) => c.projectId === projectId,
    ),

  hasConnection: (sourceCardId, targetCardId) => {
    for (const c of get().connections.values()) {
      if (c.sourceCardId === sourceCardId && c.targetCardId === targetCardId)
        return true;
      if (c.sourceCardId === targetCardId && c.targetCardId === sourceCardId)
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
