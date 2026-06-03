import type { ProjectInfo } from "@/types";
import { isTauri, ensureTauriAPIs, getInvoke } from "./runtime";
import { lsGet, lsSet } from "./storage";

/** 后端 `ProjectInfo` 的原始(snake_case)行形状。 */
interface ProjectRow {
  id: string;
  title: string;
  thumbnail: string | null;
  node_count: number;
  created_at: string;
  updated_at: string;
}

/** snake_case 行 → 前端 `ProjectInfo`。所有读项目的命令共用,避免散落多份映射。 */
function mapProjectRow(r: ProjectRow): ProjectInfo {
  return {
    id: r.id,
    title: r.title,
    thumbnail: r.thumbnail ?? undefined,
    nodeCount: r.node_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listProjects(): Promise<ProjectInfo[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    const rows = await getInvoke()<ProjectRow[]>("list_projects");
    return rows.map(mapProjectRow);
  }

  const all = lsGet<(ProjectInfo & { deletedAt?: string })[]>("projects", []);
  return all.filter((p) => !p.deletedAt);
}

export async function createProject(title: string): Promise<ProjectInfo> {
  if (isTauri) {
    await ensureTauriAPIs();
    const r = await getInvoke()<ProjectRow>("create_project", { title });
    return mapProjectRow(r);
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
    const rows = await getInvoke()<ProjectRow[]>("list_deleted_projects");
    return rows.map(mapProjectRow);
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

/** `export_project` 的统计结果(snake_case,与后端 `TransferCounts` 对应)。 */
export interface ExportSummary {
  cards: number;
  connections: number;
  groups: number;
  media: number;
  media_missing: number;
}

const PROJECT_FILE_FILTER = {
  name: "AI 无限画布项目",
  extensions: ["aicat"],
};

/**
 * 把项目导出为 `.aicat` 文件(弹系统保存对话框选目标路径)。
 * 返回 `null` 表示用户取消;否则返回导出统计。仅桌面应用可用。
 */
export async function exportProject(
  id: string,
  title: string,
): Promise<ExportSummary | null> {
  if (!isTauri) {
    throw new Error("导出功能仅在桌面应用中可用");
  }
  await ensureTauriAPIs();
  const { save } = await import("@tauri-apps/plugin-dialog");
  const destPath = await save({
    title: "导出项目",
    defaultPath: `${sanitizeFileStem(title)}.aicat`,
    filters: [PROJECT_FILE_FILTER],
  });
  if (!destPath) return null;
  return getInvoke()<ExportSummary>("export_project", { projectId: id, destPath });
}

/**
 * 从 `.aicat` 文件导入为一个全新项目(弹系统打开对话框选文件)。
 * 返回 `null` 表示用户取消;否则返回新建项目。仅桌面应用可用。
 */
export async function importProject(): Promise<ProjectInfo | null> {
  if (!isTauri) {
    throw new Error("导入功能仅在桌面应用中可用");
  }
  await ensureTauriAPIs();
  const { open } = await import("@tauri-apps/plugin-dialog");
  const srcPath = await open({
    title: "导入项目",
    multiple: false,
    directory: false,
    filters: [PROJECT_FILE_FILTER],
  });
  if (typeof srcPath !== "string") return null;
  const r = await getInvoke()<ProjectRow>("import_project", { srcPath });
  return mapProjectRow(r);
}

/** 清掉文件名里的非法路径字符,给导出对话框一个合理默认名。 */
function sanitizeFileStem(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|]/g, "_").trim();
  return cleaned || "未命名项目";
}
