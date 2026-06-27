import { describe, it, expect, beforeEach } from "vitest";
import {
  useTasksStore,
  selectCurrentTaskForCard,
  selectAttemptsForCard,
} from "@/stores/tasksStore";
import type { AsyncTask } from "@/types";

function makeTask(over: Partial<AsyncTask>): AsyncTask {
  return {
    id: "t",
    cardId: "c1",
    projectId: "p1",
    provider: "comfly",
    kind: "image_gen",
    submitEndpoint: "/v1/images",
    status: "success",
    progress: 100,
    request: {},
    result: { url: "media/images/x.png" },
    retryCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    attemptNo: 1,
    ...over,
  };
}

beforeEach(() => {
  useTasksStore.getState().clear();
});

describe("卡片任务面板 — 尝试模型选择器", () => {
  it("selectAttemptsForCard 按 attemptNo 倒序返回该卡全部尝试(含被替换的),不串卡", () => {
    const s = useTasksStore.getState();
    s.upsertLocalOnly(makeTask({ id: "a", attemptNo: 1, supersededAt: "2026-01-01T00:01:00.000Z" }));
    s.upsertLocalOnly(makeTask({ id: "b", attemptNo: 2, supersededAt: "2026-01-01T00:02:00.000Z" }));
    s.upsertLocalOnly(makeTask({ id: "c", attemptNo: 3 }));
    s.upsertLocalOnly(makeTask({ id: "other", cardId: "c2", attemptNo: 1 }));

    const list = selectAttemptsForCard("c1")(useTasksStore.getState());
    expect(list.map((t) => t.id)).toEqual(["c", "b", "a"]);
  });

  it("selectCurrentTaskForCard 只认未被替换(supersededAt 为空)的最新尝试 —— 旧任务即使后完成也不算当前", () => {
    const s = useTasksStore.getState();
    s.upsertLocalOnly(makeTask({ id: "a", attemptNo: 1, supersededAt: "2026-01-01T00:01:00.000Z" }));
    s.upsertLocalOnly(
      makeTask({ id: "c", attemptNo: 3, createdAt: "2026-01-01T00:03:00.000Z" }),
    );

    const cur = selectCurrentTaskForCard("c1")(useTasksStore.getState());
    expect(cur?.id).toBe("c");
  });

  it("被替换的任务即使 createdAt 更晚,也不会被当成当前(写闸门的判据)", () => {
    const s = useTasksStore.getState();
    // 一个更晚创建但已被替换的旧保活任务
    s.upsertLocalOnly(
      makeTask({
        id: "late-superseded",
        attemptNo: 1,
        createdAt: "2026-01-01T09:00:00.000Z",
        supersededAt: "2026-01-01T09:30:00.000Z",
      }),
    );
    // 真正的当前任务(更早创建,未被替换)
    s.upsertLocalOnly(
      makeTask({ id: "current", attemptNo: 2, createdAt: "2026-01-01T08:00:00.000Z" }),
    );

    const cur = selectCurrentTaskForCard("c1")(useTasksStore.getState());
    expect(cur?.id).toBe("current");
  });

  it("全部被替换 → 无当前尝试(undefined)", () => {
    const s = useTasksStore.getState();
    s.upsertLocalOnly(makeTask({ id: "a", supersededAt: "2026-01-01T00:01:00.000Z" }));
    s.upsertLocalOnly(makeTask({ id: "b", attemptNo: 2, supersededAt: "2026-01-01T00:02:00.000Z" }));

    expect(selectCurrentTaskForCard("c1")(useTasksStore.getState())).toBeUndefined();
  });
});
