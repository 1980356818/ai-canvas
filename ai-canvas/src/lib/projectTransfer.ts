// 项目「另存为(导出 .aicat) / 导入」的共用流程。
//
// 导出/导入都要:调平台命令 → 处理「用户取消」→ 弹 toast 反馈。这套逻辑在
// 顶部标签右键菜单(TitleBar)和「我的项目」页(ProjectsPage)都要用,集中到这里
// 单一实现,避免两处 toast 文案 / 错误处理漂移。
//
// toast / store 直接走 getState() 拿,调用方无需透传依赖。

import { exportProject, importProject } from "@/platform";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import type { ProjectInfo } from "@/types";

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 把项目另存为 `.aicat` 文件(弹系统保存对话框)。
 * 用户取消则静默返回;成功/缺失/失败各弹一种 toast。
 */
export async function exportProjectToFile(project: {
  id: string;
  title: string;
}): Promise<void> {
  const addToast = useUIStore.getState().addToast;
  try {
    const summary = await exportProject(project.id, project.title);
    if (!summary) return; // 用户取消了保存对话框
    const hasMissing = summary.media_missing > 0;
    addToast({
      type: hasMissing ? "warning" : "success",
      title: `已另存「${project.title}」`,
      description: hasMissing
        ? `${summary.cards} 张卡片；${summary.media_missing} 个媒体文件缺失已跳过`
        : `${summary.cards} 张卡片、${summary.media} 个媒体文件`,
      duration: 4000,
    });
  } catch (e) {
    addToast({
      type: "error",
      title: "另存为失败",
      description: describeError(e),
      duration: 5000,
    });
  }
}

/**
 * 从 `.aicat` 文件导入为一个全新项目(弹系统打开对话框),并加入项目列表。
 * 返回导入的项目(供调用方决定是否打开它);用户取消或导入失败均返回 `null`
 * (失败已在此弹 toast)。
 */
export async function importProjectFromFile(): Promise<ProjectInfo | null> {
  const addToast = useUIStore.getState().addToast;
  try {
    const project = await importProject();
    if (!project) return null; // 用户取消了选择对话框
    useProjectStore.getState().addProject(project);
    addToast({ type: "success", title: `已导入「${project.title}」`, duration: 3000 });
    return project;
  } catch (e) {
    addToast({
      type: "error",
      title: "导入失败",
      description: describeError(e),
      duration: 5000,
    });
    return null;
  }
}
