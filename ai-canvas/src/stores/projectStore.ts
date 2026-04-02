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

  setProjects: (projects: ProjectInfo[]) => void;
  setCurrentProjectId: (id: string | null) => void;
  addProject: (project: ProjectInfo) => void;
  removeProject: (id: string) => void;
  updateProject: (id: string, partial: Partial<ProjectInfo>) => void;
  getCurrentProject: () => ProjectInfo | undefined;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentProjectId: null,

  setProjects: (projects) => set({ projects }),

  setCurrentProjectId: (id) => set({ currentProjectId: id }),

  addProject: (project) =>
    set((s) => ({ projects: [project, ...s.projects] })),

  removeProject: (id) =>
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
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
}));
