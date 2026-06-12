/** 项目动词:列出 / 新建 / 打开。 */

import type { VerbDefinition } from "../types";
import { fail } from "../types";
import { listProjects, createProject } from "@/platform";
import { useProjectStore } from "@/stores/projectStore";
import { useCardStore } from "@/stores/cardStore";
import { openProjectAndWait } from "../projectGateway";

const projectList: VerbDefinition = {
  name: "project.list",
  description: "列出所有项目(不含回收站),返回 id / 标题 / 卡片数 / 更新时间。",
  params: { type: "object", properties: {} },
  async handler() {
    const projects = await listProjects();
    useProjectStore.getState().setProjects(projects);
    return {
      projects: projects.map((p) => ({
        id: p.id,
        title: p.title,
        nodeCount: p.nodeCount,
        updatedAt: p.updatedAt,
      })),
    };
  },
};

const projectCreate: VerbDefinition = {
  name: "project.create",
  description: "新建一个空白项目,返回 projectId。新建后通常紧接着 project.open。",
  params: {
    type: "object",
    properties: { title: { type: "string", description: "项目标题" } },
    required: ["title"],
  },
  async handler(params) {
    const title = String(params.title ?? "").trim() || "未命名项目";
    const project = await createProject(title);
    useProjectStore.getState().addProject(project);
    return { projectId: project.id, title: project.title };
  },
};

const projectOpen: VerbDefinition = {
  name: "project.open",
  description:
    "打开项目并等待画布数据加载完成。必须先打开,之后才能对其 card.create / connection.create / run.*。",
  params: {
    type: "object",
    properties: { projectId: { type: "string" } },
    required: ["projectId"],
  },
  async handler(params) {
    const projectId = String(params.projectId ?? "");
    if (!projectId) throw fail("INVALID_ARGS", "缺少 projectId");
    await openProjectAndWait(projectId);
    const cardCount = useCardStore.getState().getCardsByProject(projectId).length;
    return { projectId, ready: true, cardCount };
  },
};

export const projectVerbs: VerbDefinition[] = [projectList, projectCreate, projectOpen];
