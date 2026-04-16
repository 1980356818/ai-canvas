import { create } from "zustand";

export interface ProjectInfo {
  id: string;
  title: string;
  thumbnail?: string;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

function sortByUpdatedDesc(projects: ProjectInfo[]): ProjectInfo[] {
  return [...projects].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

interface ProjectState {
  projects: ProjectInfo[];
  deletedProjects: ProjectInfo[];
  currentProjectId: string | null;
  openProjectIds: string[];

  setProjects: (projects: ProjectInfo[]) => void;
  setDeletedProjects: (projects: ProjectInfo[]) => void;
  setCurrentProjectId: (id: string | null) => void;
  addProject: (project: ProjectInfo) => void;
  removeProject: (id: string) => void;
  restoreProject: (id: string) => void;
  permanentlyRemoveProject: (id: string) => void;
  updateProject: (id: string, partial: Partial<ProjectInfo>) => void;
  getCurrentProject: () => ProjectInfo | undefined;
  openProject: (id: string) => void;
  closeProject: (id: string) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  deletedProjects: [],
  currentProjectId: null,
  openProjectIds: [],

  setProjects: (projects) => set({ projects: sortByUpdatedDesc(projects) }),

  setDeletedProjects: (deletedProjects) => set({ deletedProjects }),

  setCurrentProjectId: (id) => set({ currentProjectId: id }),

  addProject: (project) =>
    set((s) => ({ projects: sortByUpdatedDesc([project, ...s.projects]) })),

  removeProject: (id) =>
    set((s) => {
      const removed = s.projects.find((p) => p.id === id);
      return {
        projects: s.projects.filter((p) => p.id !== id),
        deletedProjects: removed
          ? [removed, ...s.deletedProjects]
          : s.deletedProjects,
        openProjectIds: s.openProjectIds.filter((pid) => pid !== id),
        currentProjectId:
          s.currentProjectId === id ? null : s.currentProjectId,
      };
    }),

  restoreProject: (id) =>
    set((s) => {
      const restored = s.deletedProjects.find((p) => p.id === id);
      return {
        deletedProjects: s.deletedProjects.filter((p) => p.id !== id),
        projects: restored
          ? sortByUpdatedDesc([restored, ...s.projects])
          : s.projects,
      };
    }),

  permanentlyRemoveProject: (id) =>
    set((s) => ({
      deletedProjects: s.deletedProjects.filter((p) => p.id !== id),
    })),

  updateProject: (id, partial) =>
    set((s) => {
      const updated = s.projects.map((p) =>
        p.id === id ? { ...p, ...partial } : p,
      );
      return {
        projects: partial.updatedAt ? sortByUpdatedDesc(updated) : updated,
      };
    }),

  getCurrentProject: () => {
    const { projects, currentProjectId } = get();
    return projects.find((p) => p.id === currentProjectId);
  },

  openProject: (id) =>
    set((s) => ({
      currentProjectId: id,
      openProjectIds: s.openProjectIds.includes(id)
        ? s.openProjectIds
        : [...s.openProjectIds, id],
    })),

  closeProject: (id) => {
    const { openProjectIds, currentProjectId } = get();
    const next = openProjectIds.filter((pid) => pid !== id);
    if (id === currentProjectId) {
      const idx = openProjectIds.indexOf(id);
      const nextId = next[Math.min(idx, next.length - 1)] ?? null;
      set({ openProjectIds: next, currentProjectId: nextId });
    } else {
      set({ openProjectIds: next });
    }
  },
}));
