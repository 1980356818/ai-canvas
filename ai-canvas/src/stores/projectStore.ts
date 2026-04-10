import { create } from "zustand";

export interface ProjectInfo {
  id: string;
  title: string;
  thumbnail?: string;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ProjectState {
  projects: ProjectInfo[];
  currentProjectId: string | null;
  openProjectIds: string[];

  setProjects: (projects: ProjectInfo[]) => void;
  setCurrentProjectId: (id: string | null) => void;
  addProject: (project: ProjectInfo) => void;
  removeProject: (id: string) => void;
  updateProject: (id: string, partial: Partial<ProjectInfo>) => void;
  getCurrentProject: () => ProjectInfo | undefined;
  openProject: (id: string) => void;
  closeProject: (id: string) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentProjectId: null,
  openProjectIds: [],

  setProjects: (projects) => set({ projects }),

  setCurrentProjectId: (id) => set({ currentProjectId: id }),

  addProject: (project) =>
    set((s) => ({ projects: [project, ...s.projects] })),

  removeProject: (id) =>
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      openProjectIds: s.openProjectIds.filter((pid) => pid !== id),
      currentProjectId: s.currentProjectId === id ? null : s.currentProjectId,
    })),

  updateProject: (id, partial) =>
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === id ? { ...p, ...partial } : p,
      ),
    })),

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
