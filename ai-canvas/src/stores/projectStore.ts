import { create } from "zustand";

export type { ProjectInfo } from "@/types";
import type { ProjectInfo } from "@/types";

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
  /**
   * 「该项目的卡片/连线/组已全部加载进 store」的就绪信号,由 useProjectLifecycle 在
   * 加载完成时置为该项目 id、切换项目时清空。自动化桥的 `project.open` 动词 await 它,
   * 确保后续 card.create / canvas.snapshot 读到的是已水合的 store(而非加载中途的空集)。
   */
  hydratedProjectId: string | null;

  setProjects: (projects: ProjectInfo[]) => void;
  setDeletedProjects: (projects: ProjectInfo[]) => void;
  setCurrentProjectId: (id: string | null) => void;
  setHydratedProjectId: (id: string | null) => void;
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
  hydratedProjectId: null,

  setProjects: (projects) => set({ projects: sortByUpdatedDesc(projects) }),

  setDeletedProjects: (deletedProjects) => set({ deletedProjects }),

  setCurrentProjectId: (id) => set({ currentProjectId: id }),

  setHydratedProjectId: (id) => set({ hydratedProjectId: id }),

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
