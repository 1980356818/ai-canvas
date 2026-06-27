import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  reconcileFrameMembership,
  cardsInFrame,
  scheduleFrameMembershipReconcile,
  installFrameMembershipAutoReconcile,
} from "@/lib/frameMembership";
import { useCardStore } from "@/stores/cardStore";
import { useGroupStore } from "@/stores/groupStore";
import { useProjectStore } from "@/stores/projectStore";
import type { CanvasCard, CardGroup } from "@/types";

/** 把队列里的微任务跑干净(scheduleFrameMembershipReconcile 用 queueMicrotask 去抖)。 */
const flushMicrotasks = () =>
  new Promise<void>((resolve) => queueMicrotask(resolve));

const P = "proj-1";

function mkCard(id: string, x: number, y: number, w = 100, h = 100): CanvasCard {
  return {
    id,
    projectId: P,
    type: "text",
    x,
    y,
    width: w,
    height: h,
    zIndex: 1,
    locked: false,
    collapsed: false,
    data: {},
    createdAt: "t0",
    updatedAt: "t0",
  };
}

function mkFrame(
  id: string,
  rect: { x: number; y: number; width: number; height: number },
  cardIds: string[] = [],
  collapsed = false,
): CardGroup {
  return {
    id,
    projectId: P,
    cardIds,
    title: id,
    color: "#7C3AED",
    collapsed,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    createdAt: "t0",
    updatedAt: "t0",
  };
}

const idsOf = (gid: string) =>
  [...(useGroupStore.getState().getGroup(gid)?.cardIds ?? [])].sort();

beforeEach(() => {
  useCardStore.getState().setCards([]);
  useGroupStore.getState().setGroups([]);
});

describe("cardsInFrame", () => {
  it("命中 = 卡片中心点落在 rect 内(闭区间)", () => {
    const cards = new Map<string, CanvasCard>([
      ["in", mkCard("in", 50, 50)], // center (100,100) ∈
      ["out", mkCard("out", 400, 400)], // center (450,450) ∉
    ]);
    const hit = cardsInFrame({ x: 0, y: 0, width: 300, height: 300 }, cards);
    expect(hit).toEqual(["in"]);
  });
});

describe("reconcileFrameMembership", () => {
  it("把框内的非成员卡吸收进来,框外的不动(空间即真相)", () => {
    // A 初始是成员;B 落在框内但不是成员(模拟导入掉组);C 在框外。
    useCardStore.getState().setCards([
      mkCard("A", 50, 50), // center (100,100) ∈
      mkCard("B", 150, 150), // center (200,200) ∈
      mkCard("C", 400, 400), // center (450,450) ∉
    ]);
    useGroupStore
      .getState()
      .setGroups([mkFrame("F", { x: 0, y: 0, width: 300, height: 300 }, ["A"])]);

    const changed = reconcileFrameMembership(P);

    expect(changed).toBe(true);
    expect(idsOf("F")).toEqual(["A", "B"]); // B 被吸收,C 不在
  });

  it("重叠框:自由卡归属最上层(渲染顺序靠后)的框", () => {
    // X 不属任何框(自由卡)→ 走空间吸收,归命中它的最上层框 F2。
    useCardStore.getState().setCards([mkCard("X", 150, 150)]); // center (200,200)
    useGroupStore.getState().setGroups([
      mkFrame("F1", { x: 0, y: 0, width: 300, height: 300 }), // 底层
      mkFrame("F2", { x: 100, y: 100, width: 300, height: 300 }), // 顶层(后绘制)
    ]);

    reconcileFrameMembership(P);

    expect(idsOf("F2")).toEqual(["X"]);
    expect(idsOf("F1")).toEqual([]);
  });

  it("重叠框:既有成员留守原框,不被最上层框抢走(按组复制核心修复)", () => {
    // M 是底层框 F1 的成员,几何上同时落在顶层框 F2 内
    //(模拟「按组复制」出的同位副本框压在源框上)。
    // 成员粘性:M 仍在 F1 内 → 留在 F1,不被最上层 F2 吸走 → 拖 F1 时 M 跟走。
    useCardStore.getState().setCards([mkCard("M", 150, 150)]); // center (200,200) ∈ 两框
    useGroupStore.getState().setGroups([
      mkFrame("F1", { x: 0, y: 0, width: 300, height: 300 }, ["M"]), // 底层,M 的原属框
      mkFrame("F2", { x: 100, y: 100, width: 300, height: 300 }), // 顶层,后绘制
    ]);

    reconcileFrameMembership(P);

    expect(idsOf("F1")).toEqual(["M"]); // 留在原框
    expect(idsOf("F2")).toEqual([]); // 顶层框没抢走
  });

  it("重叠框:各框留守自己的成员,只有自由卡归最上层", () => {
    // a∈F1、b∈F2 各为既有成员;f 是自由卡。三者中心都落在两框重叠区。
    useCardStore.getState().setCards([
      mkCard("a", 150, 150), // center (200,200)
      mkCard("b", 160, 160), // center (210,210)
      mkCard("f", 170, 170), // center (220,220)
    ]);
    useGroupStore.getState().setGroups([
      mkFrame("F1", { x: 0, y: 0, width: 400, height: 400 }, ["a"]), // 底层
      mkFrame("F2", { x: 50, y: 50, width: 400, height: 400 }, ["b"]), // 顶层
    ]);

    reconcileFrameMembership(P);

    expect(idsOf("F1")).toEqual(["a"]); // a 留守 F1(不被 F2 抢)
    expect(idsOf("F2")).toEqual(["b", "f"]); // b 留守 F2;自由卡 f 归最上层 F2
  });

  it("折叠框冻结:成员不变,且其成员不被其它框吸走;框内非冻结卡仍按空间归属", () => {
    useCardStore.getState().setCards([
      mkCard("A", 20, 20), // 折叠框 FC 的冻结成员,几何上也落在展开框 FE 内
      mkCard("B", 60, 60), // 自由卡,落在 FE 内
    ]);
    useGroupStore.getState().setGroups([
      mkFrame("FC", { x: 0, y: 0, width: 200, height: 200 }, ["A"], true), // 折叠
      mkFrame("FE", { x: 0, y: 0, width: 400, height: 400 }), // 展开,覆盖 A 和 B
    ]);

    reconcileFrameMembership(P);

    expect(idsOf("FC")).toEqual(["A"]); // 折叠框成员冻结
    expect(idsOf("FE")).toEqual(["B"]); // 只吸收自由卡 B,不抢冻结的 A
  });

  it("成员移出框 → 自动出组,空框保留(不删除)", () => {
    useCardStore.getState().setCards([mkCard("A", 500, 500)]); // center 远在框外
    useGroupStore
      .getState()
      .setGroups([mkFrame("F", { x: 0, y: 0, width: 100, height: 100 }, ["A"])]);

    reconcileFrameMembership(P);

    expect(idsOf("F")).toEqual([]); // A 出组
    expect(useGroupStore.getState().getGroup("F")).toBeDefined(); // 空框仍在
  });
});

describe("scheduleFrameMembershipReconcile(微任务去抖)", () => {
  it("调度后在微任务末跑一次 reconcile;同 tick 多次调度合并", async () => {
    useCardStore.getState().setCards([
      mkCard("A", 50, 50), // ∈
      mkCard("B", 150, 150), // ∈,但不在 cardIds
    ]);
    useGroupStore
      .getState()
      .setGroups([mkFrame("F", { x: 0, y: 0, width: 300, height: 300 }, ["A"])]);

    scheduleFrameMembershipReconcile(P);
    scheduleFrameMembershipReconcile(P); // 合并,不重复跑
    expect(idsOf("F")).toEqual(["A"]); // 同步阶段还没跑(去抖到微任务)

    await flushMicrotasks();
    expect(idsOf("F")).toEqual(["A", "B"]); // 微任务末已校准
  });
});

describe("installFrameMembershipAutoReconcile(订阅 layoutVersion 自动校准)", () => {
  let uninstall: (() => void) | null = null;

  beforeEach(() => {
    useCardStore.getState().setCards([]);
    useGroupStore.getState().setGroups([]);
    useProjectStore.getState().setCurrentProjectId(P);
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("卡片几何/增删改动后自动重算成员(卡侧无需手动 reconcile)", async () => {
    useCardStore.getState().setCards([mkCard("A", 50, 50)]); // ∈
    useGroupStore
      .getState()
      .setGroups([mkFrame("F", { x: 0, y: 0, width: 300, height: 300 }, ["A"])]);

    uninstall = installFrameMembershipAutoReconcile();

    // 模拟「在框里新建一张卡」(addCard bump layoutVersion)——卡侧不手动 reconcile。
    useCardStore.getState().addCard(mkCard("C", 150, 150)); // center (200,200) ∈
    await flushMicrotasks();

    expect(idsOf("F")).toEqual(["A", "C"]); // C 被自动吸收进框
  });

  it("卸载后不再自动校准", async () => {
    useCardStore.getState().setCards([mkCard("A", 50, 50)]);
    useGroupStore
      .getState()
      .setGroups([mkFrame("F", { x: 0, y: 0, width: 300, height: 300 }, ["A"])]);

    const off = installFrameMembershipAutoReconcile();
    off(); // 立即卸载

    useCardStore.getState().addCard(mkCard("C", 150, 150));
    await flushMicrotasks();

    expect(idsOf("F")).toEqual(["A"]); // 没有自动校准,C 未入组
  });

  it("幂等:重复安装只订阅一次(不重复吸收 / 不抛错)", async () => {
    useCardStore.getState().setCards([mkCard("A", 50, 50)]);
    useGroupStore
      .getState()
      .setGroups([mkFrame("F", { x: 0, y: 0, width: 300, height: 300 }, ["A"])]);

    installFrameMembershipAutoReconcile();
    uninstall = installFrameMembershipAutoReconcile(); // 第二次 = no-op,返回同一卸载器

    useCardStore.getState().addCard(mkCard("C", 150, 150));
    await flushMicrotasks();

    expect(idsOf("F")).toEqual(["A", "C"]);
  });
});
