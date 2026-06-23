/**
 * 项目网关 —— 所有"对某项目操作"的动词的统一前置。
 *
 * 自动化动词不直接 setCards(那会与 useProjectLifecycle 的加载互相覆盖,见
 * docs/automation §2)。它们经此打开项目、等待 store 水合完成 (hydratedProjectId 信号),
 * 然后才往已水合的 store 写。
 */

import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { listProjects } from "@/platform";
import { fail } from "./types";

/** 轮询等待 `pred` 为真,带超时。命中返回 true,超时返回最后一次判定。 */
async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
  stepMs = 50,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return pred();
}

/**
 * 打开项目并等待其卡片/连线/组水合到 store。幂等:已打开且已水合则立即返回。
 *
 * @throws VerbError NOT_FOUND 项目不存在;INTERNAL 加载超时。
 */
export async function openProjectAndWait(
  projectId: string,
  timeoutMs = 10000,
): Promise<void> {
  // 项目列表里没有 → 刷新一次再判 (冷启动 / 直接 open 旧项目的场景)。
  let exists = useProjectStore.getState().projects.some((p) => p.id === projectId);
  if (!exists) {
    const list = await listProjects();
    useProjectStore.getState().setProjects(list);
    exists = list.some((p) => p.id === projectId);
  }
  if (!exists) throw fail("NOT_FOUND", `项目不存在: ${projectId}`);

  const store = useProjectStore.getState();
  if (store.currentProjectId === projectId && store.hydratedProjectId === projectId) {
    return;
  }

  useProjectStore.getState().openProject(projectId);
  useUIStore.getState().setAppView("canvas");

  const ok = await waitFor(
    () => useProjectStore.getState().hydratedProjectId === projectId,
    timeoutMs,
  );
  if (!ok) throw fail("INTERNAL", "项目加载超时,请重试");
}

/**
 * 解析目标项目并确保其已打开+水合。`projectId` 省略时用当前打开的项目。
 * card / connection / canvas / run 系动词都经此拿到一个"可安全读写"的 projectId。
 */
export async function resolveAndOpenProject(projectId?: string): Promise<string> {
  const target = projectId ?? useProjectStore.getState().currentProjectId;
  if (!target) {
    throw fail("INVALID_ARGS", "缺少 projectId,且当前没有打开的项目");
  }
  await openProjectAndWait(target);
  return target;
}
