/**
 * 自动化动词层端到端测试 —— 直接驱动 `handleRequest`(外部 HTTP/MCP 与对话面板的共同执行端),
 * 跑完整工作流并断言 store 真实变化。覆盖:建项目/卡/连线、快照、运行(轮询任务)、黑箱门禁、
 * spec 声明式导入(含校验失败回滚)、删卡、未知动词。
 *
 * mock 边界:持久化(@/platform)、生成(cardRunner/groupRunner)、autoSave 都打桩 —— 本测试验
 * "动词正确操控画布数据流",不验真出图/真写盘(那是 cardRunner / Tauri 的事)。
 *
 * `project.open` 依赖 useProjectLifecycle(React effect 点亮 hydratedProjectId),node 环境无法
 * 触发,故用 `openProjectInStore` 手动模拟"项目已打开且已水合";动词内部的 resolveAndOpenProject
 * 命中已水合状态即直接通过,与真 app 行为一致。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/cardRunner", () => ({
  runCard: vi.fn(async () => ({ outcome: "ok" as const })),
}));
vi.mock("@/services/groupRun", () => ({
  runGroup: vi.fn(async () => ({
    groupId: "g",
    ok: 1,
    skipped: 0,
    failed: 0,
    notDispatched: 0,
    ran: true,
    endState: "completed" as const,
  })),
  stopGroup: vi.fn(() => true),
}));
vi.mock("@/lib/autoSave", () => ({
  autoSave: { markDirty: vi.fn(), forceSave: vi.fn() },
}));

let projectSeq = 0;
vi.mock("@/platform", () => ({
  createProject: vi.fn(async (title: string) => ({
    id: `proj-${++projectSeq}`,
    title,
    nodeCount: 0,
    createdAt: "x",
    updatedAt: "x",
  })),
  listProjects: vi.fn(async () => []),
  deleteCard: vi.fn(async () => undefined),
  saveCardsBatch: vi.fn(async () => undefined),
  saveConnections: vi.fn(async () => undefined),
}));

import { handleRequest } from "@/services/automation/host";
import { registerAllVerbs } from "@/services/automation/verbs";
import type { CallResponse } from "@/services/automation/types";
import { useCardStore } from "@/stores/cardStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProjectStore } from "@/stores/projectStore";
import { cloakPrompt } from "@/lib/promptCloak";

registerAllVerbs();

let reqSeq = 0;
async function call(verb: string, params: unknown = {}): Promise<CallResponse> {
  reqSeq += 1;
  return handleRequest({ requestId: `t${reqSeq}`, verb, params, source: "bridge" });
}

/** 取成功响应的 data,顺带断言 ok。 */
function okData<T = Record<string, unknown>>(resp: CallResponse): T {
  expect(resp.ok, JSON.stringify(resp.error)).toBe(true);
  return resp.data as T;
}

/** 手动把某项目置为"已打开且已水合"(替代 useProjectLifecycle)。 */
function openProjectInStore(pid: string): void {
  useProjectStore.getState().setProjects([
    { id: pid, title: "测试项目", nodeCount: 0, createdAt: "x", updatedAt: "x" },
  ]);
  useProjectStore.getState().setCurrentProjectId(pid);
  useProjectStore.getState().setHydratedProjectId(pid);
}

beforeEach(() => {
  useCardStore.getState().clear();
  useConnectionStore.getState().clear();
  useProjectStore.setState({
    projects: [],
    deletedProjects: [],
    currentProjectId: null,
    hydratedProjectId: null,
    openProjectIds: [],
  });
});

describe("automation verbs E2E", () => {
  it("project.create 建项目并进 store", async () => {
    const data = okData<{ projectId: string }>(
      await call("project.create", { title: "我的项目" }),
    );
    expect(data.projectId).toMatch(/^proj-/);
    expect(useProjectStore.getState().projects.some((p) => p.id === data.projectId)).toBe(true);
  });

  it("card.create 把提示词写进 data.content", async () => {
    openProjectInStore("p1");
    const { cardId } = okData<{ cardId: string }>(
      await call("card.create", { type: "text", prompt: "一只赛博猫" }),
    );
    const card = useCardStore.getState().getCard(cardId);
    expect(card?.type).toBe("text");
    expect((card?.data as { content: string }).content).toBe("一只赛博猫");
  });

  it("建两卡 + 连线 + 快照", async () => {
    openProjectInStore("p1");
    const c1 = okData<{ cardId: string }>(
      await call("card.create", { type: "text", prompt: "白底极简" }),
    ).cardId;
    const c2 = okData<{ cardId: string }>(
      await call("card.create", { type: "ai_image", size: "1:1" }),
    ).cardId;
    const conn = okData<{ connectionId: string; created: boolean }>(
      await call("connection.create", { sourceCardId: c1, targetCardId: c2 }),
    );
    expect(conn.created).toBe(true);

    const snap = okData<{
      cards: Array<{ id: string }>;
      connections: Array<{ from: string; to: string }>;
    }>(await call("canvas.snapshot", {}));
    expect(snap.cards).toHaveLength(2);
    expect(snap.connections).toEqual([{ id: expect.any(String), from: c1, to: c2 }]);
  });

  it("connection.create 拒绝自环与跨项目/不存在卡片", async () => {
    openProjectInStore("p1");
    const c1 = okData<{ cardId: string }>(
      await call("card.create", { type: "text", prompt: "x" }),
    ).cardId;
    const selfLoop = await call("connection.create", { sourceCardId: c1, targetCardId: c1 });
    expect(selfLoop.ok).toBe(false);
    expect(selfLoop.error?.code).toBe("INVALID_ARGS");

    const missing = await call("connection.create", { sourceCardId: c1, targetCardId: "nope" });
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("NOT_FOUND");
  });

  it("run.card 提交后轮询任务到 succeeded", async () => {
    openProjectInStore("p1");
    const cardId = okData<{ cardId: string }>(
      await call("card.create", { type: "ai_image", prompt: "猫" }),
    ).cardId;
    const { taskId } = okData<{ taskId: string }>(await call("run.card", { cardId }));
    expect(taskId).toMatch(/^t_/);

    let state = "running";
    for (let i = 0; i < 50 && state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      state = okData<{ state: string }>(await call("task.status", { taskId })).state;
    }
    expect(state).toBe("succeeded");
  });

  it("黑箱:封装卡快照返回 [已封装]、改其提示词被 GATED", async () => {
    openProjectInStore("p1");
    const cloaked = cloakPrompt("绝密提示词");
    const { cardId } = okData<{ cardId: string }>(
      await call("card.create", { type: "text", prompt: cloaked }),
    );

    const snap = okData<{ cards: Array<{ id: string; prompt: string; cloaked: boolean }> }>(
      await call("canvas.snapshot", {}),
    );
    const card = snap.cards.find((c) => c.id === cardId)!;
    expect(card.cloaked).toBe(true);
    expect(card.prompt).toBe("[已封装]");
    expect(card.prompt).not.toContain("绝密");

    const upd = await call("card.update", { cardId, prompt: "试图覆盖" });
    expect(upd.ok).toBe(false);
    expect(upd.error?.code).toBe("GATED");
  });

  it("spec.import 事务式建图并返回 ref→id", async () => {
    openProjectInStore("p1");
    const data = okData<{
      cardCount: number;
      connectionCount: number;
      refToId: Record<string, string>;
    }>(
      await call("spec.import", {
        projectId: "p1",
        spec: {
          specVersion: 1,
          cards: [
            { ref: "p", type: "text", prompt: "提示词" },
            { ref: "i", type: "ai_image", size: "16:9" },
          ],
          connections: [{ from: "p", to: "i" }],
        },
      }),
    );
    expect(data.cardCount).toBe(2);
    expect(data.connectionCount).toBe(1);
    expect(useCardStore.getState().getCardsByProject("p1")).toHaveLength(2);
    expect(useConnectionStore.getState().getConnectionsByProject("p1")).toHaveLength(1);
    // 连线端点正确映射 ref→id
    const conn = useConnectionStore.getState().getConnectionsByProject("p1")[0]!;
    expect(conn.sourceCardId).toBe(data.refToId.p);
    expect(conn.targetCardId).toBe(data.refToId.i);
  });

  it("spec.import 校验失败(连线引用不存在 ref)整单拒绝、不留半成品", async () => {
    openProjectInStore("p1");
    const resp = await call("spec.import", {
      projectId: "p1",
      spec: {
        specVersion: 1,
        cards: [{ ref: "a", type: "text", prompt: "x" }],
        connections: [{ from: "a", to: "ghost" }],
      },
    });
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("INVALID_ARGS");
    // 校验在创建之前 → 一张卡都不应落地
    expect(useCardStore.getState().getCardsByProject("p1")).toHaveLength(0);
  });

  it("card.delete 连带移除卡片", async () => {
    openProjectInStore("p1");
    const { cardId } = okData<{ cardId: string }>(
      await call("card.create", { type: "text", prompt: "待删" }),
    );
    expect(useCardStore.getState().getCard(cardId)).toBeDefined();
    okData(await call("card.delete", { cardId }));
    expect(useCardStore.getState().getCard(cardId)).toBeUndefined();
  });

  it("未知动词返回 NOT_FOUND", async () => {
    const resp = await call("does.not.exist", {});
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("NOT_FOUND");
  });
});
