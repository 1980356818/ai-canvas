import type { ProjectInfo } from "@/types";
import { isTauri, ensureTauriAPIs, getInvoke } from "./runtime";
import { lsGet, lsSet } from "./storage";

export async function listProjects(): Promise<ProjectInfo[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    const rows = await getInvoke()<
      {
        id: string;
        title: string;
        thumbnail: string | null;
        node_count: number;
        created_at: string;
        updated_at: string;
      }[]
    >("list_projects");
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      thumbnail: r.thumbnail ?? undefined,
      nodeCount: r.node_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  const all = lsGet<(ProjectInfo & { deletedAt?: string })[]>("projects", []);
  return all.filter((p) => !p.deletedAt);
}

export async function createProject(title: string): Promise<ProjectInfo> {
  if (isTauri) {
    await ensureTauriAPIs();
    const r = await getInvoke()<{
      id: string;
      title: string;
      thumbnail: string | null;
      node_count: number;
      created_at: string;
      updated_at: string;
    }>("create_project", { title });
    return {
      id: r.id,
      title: r.title,
      thumbnail: r.thumbnail ?? undefined,
      nodeCount: r.node_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  const now = new Date().toISOString();
  const project: ProjectInfo = {
    id: crypto.randomUUID(),
    title,
    nodeCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const projects = lsGet<ProjectInfo[]>("projects", []);
  projects.unshift(project);
  lsSet("projects", projects);
  return project;
}

export async function deleteProject(id: string): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await getInvoke()("delete_project", { id });
    return;
  }

  const projects = lsGet<ProjectInfo[]>("projects", []);
  const target = projects.find((p) => p.id === id);
  if (target) {
    (target as ProjectInfo & { deletedAt?: string }).deletedAt = new Date().toISOString();
    lsSet("projects", projects);
  }
}

export async function listDeletedProjects(): Promise<ProjectInfo[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    const rows = await getInvoke()<
      {
        id: string;
        title: string;
        thumbnail: string | null;
        node_count: number;
        created_at: string;
        updated_at: string;
      }[]
    >("list_deleted_projects");
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      thumbnail: r.thumbnail ?? undefined,
      nodeCount: r.node_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  const all = lsGet<(ProjectInfo & { deletedAt?: string })[]>("projects", []);
  return all.filter((p) => !!p.deletedAt);
}

export async function restoreProject(id: string): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await getInvoke()("restore_project", { id });
    return;
  }

  const projects = lsGet<(ProjectInfo & { deletedAt?: string })[]>("projects", []);
  const target = projects.find((p) => p.id === id);
  if (target) {
    delete target.deletedAt;
    lsSet("projects", projects);
  }
}

export async function permanentlyDeleteProject(id: string): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await getInvoke()("permanently_delete_project", { id });
    return;
  }

  const projects = lsGet<ProjectInfo[]>("projects", []);
  lsSet(
    "projects",
    projects.filter((p) => p.id !== id),
  );
  localStorage.removeItem("ai_canvas_cards_" + id);
  localStorage.removeItem("ai_canvas_viewport_" + id);
}

export async function renameProject(
  id: string,
  title: string,
): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await getInvoke()("rename_project", { id, title });
    return;
  }

  const projects = lsGet<ProjectInfo[]>("projects", []);
  const p = projects.find((x) => x.id === id);
  if (p) {
    p.title = title;
    p.updatedAt = new Date().toISOString();
    lsSet("projects", projects);
  }
}

export async function updateProjectMeta(
  id: string,
  partial: Partial<ProjectInfo>,
): Promise<void> {
  if (isTauri) {
    return;
  }

  const projects = lsGet<ProjectInfo[]>("projects", []);
  const p = projects.find((x) => x.id === id);
  if (p) {
    Object.assign(p, partial, { updatedAt: new Date().toISOString() });
    lsSet("projects", projects);
  }
}
