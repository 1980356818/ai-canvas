/**
 * Frame 成员校准权威 —— 唯一的「谁属于哪个框」写入口。
 *
 * Frame 容器化后,组(Frame)拥有自己存储的边界矩形,**成员 = 中心点落在框内的卡片**
 * (空间即真相)。`group.cardIds` 降级为「派生缓存」:不再由用户手动增删,而是由本模块
 * 在每次几何提交(打开项目 / 移卡 / 移框 / 缩放框 / 建删卡)后从边界重算并落库。
 *
 * 规则:
 *   - 命中判定:卡片中心点 ∈ 框 rect(与 hitGroupAt 同源)。
 *   - 单成员:一卡只属一框。重叠时**成员粘性优先**:已属某框、且中心仍落在该框内的卡
 *     保持原归属(重叠框**不互相吞并**对方的既有成员);只有**自由卡**(无主 / 新建 /
 *     导入掉组 / 掉出原框)才被命中它的**最上层框**吸收(沿 getGroupsByProject 渲染顺序,
 *     后者覆盖前者)。粘性是「按组复制出同位副本框后,拖框成员仍跟走」的关键。
 *   - 折叠冻结:折叠框的成员保持不变,且其成员不参与其它框的空间吸收
 *     (折叠后 rect 缩成胶囊,无法再靠空间判定,必须冻结)。
 *
 * 性能:O(框数 × 卡数),只在「提交时」跑一次(非每帧),典型画布完全可接受。
 * 详见 docs/Frame容器化-架构与施工图.md。
 *
 * ─── 谁负责触发 reconcile(统一契约,见 {@link installFrameMembershipAutoReconcile})──
 * 「卡片几何/增删」变了就要重算成员,但散落在各处手动调 reconcile 极易漏(新建/粘贴/
 * 排版/程序化移动都曾漏过 → 框里看得到的卡却不在 cardIds、组运行静默漏跑)。现在统一为:
 *   • **卡侧**(移卡 / 建卡 / 删卡 / 缩放卡 / 粘贴 / 排版 / 程序化 / agent)——
 *     由 {@link installFrameMembershipAutoReconcile} 订阅 `cardStore.layoutVersion` **自动**
 *     校准,任何新增几何路径都**无需**再记得手动调。这是卡侧的权威入口。
 *   • **框侧**(移框 / 缩放框)—— 由 useGroupDrag / useGroupResize 的 pointer-up 显式同步
 *     reconcile(订阅只看卡几何、看不见框几何;且这里需即时落库)。
 *   • **打开项目** —— useProjectLifecycle 显式同步(与 backfill / 一致性回写有顺序依赖)。
 *   • **组运行前** —— planGroupRun 显式同步(自动校准是异步去抖,运行须先同步保证
 *     「跑的 = 当前框里看到的」,等不了微任务)。
 */

import { useCardStore } from "@/stores/cardStore";
import { useGroupStore } from "@/stores/groupStore";
import { useProjectStore } from "@/stores/projectStore";
import { computeGroupBounds, type GroupBounds } from "@/lib/groupBounds";
import { groupToRow } from "@/lib/mappers";
import { saveGroupsBatch } from "@/platform";
import type { CanvasCard } from "@/types";

/** 卡片中心点是否落在 rect 内(闭区间)。 */
function centerInRect(card: CanvasCard, rect: GroupBounds): boolean {
  const cx = card.x + card.width / 2;
  const cy = card.y + card.height / 2;
  return (
    cx >= rect.x &&
    cx <= rect.x + rect.width &&
    cy >= rect.y &&
    cy <= rect.y + rect.height
  );
}

/** 返回中心点落在 rect 内的卡片 id(纯函数,不读全局)。 */
export function cardsInFrame(
  rect: GroupBounds,
  cards: Map<string, CanvasCard>,
): string[] {
  const out: string[] = [];
  for (const [cid, c] of cards) {
    if (centerInRect(c, rect)) out.push(cid);
  }
  return out;
}

/**
 * 按存储边界重算某项目所有展开框的成员,写回 store + 落库(仅在有变化时)。
 * 返回是否发生了成员变化。
 */
export function reconcileFrameMembership(projectId: string): boolean {
  const groupStore = useGroupStore.getState();
  const groups = groupStore.getGroupsByProject(projectId); // 渲染顺序
  if (groups.length === 0) return false;

  const cards = useCardStore.getState().cards;

  // 折叠框成员冻结:保持原样,且这些卡不参与任何框的空间吸收。
  const frozen = new Set<string>();
  for (const g of groups) {
    if (g.collapsed) for (const cid of g.cardIds) frozen.add(cid);
  }

  // 每张卡 → 归属的展开框。分两轮,体现「成员粘性优先于空间吸收」:
  //   轮1(粘性):已是某框成员、且中心仍落在该框 rect 内的卡,保持原归属 —— 这样
  //     **重叠框不会把对方的既有成员抢走**。否则「按组复制」出的同位副本框会和源框
  //     互相吞并成员,导致拖框时框里的卡不跟走(本次修复的根因)。
  //   轮2(吸收):仍无主的「自由卡」(新建 / 导入掉组 / 移入框 / 掉出原框)归命中它的
  //     **最上层框**(渲染顺序后者覆盖前者 → 最上层赢)。
  // 先把各展开框的 rect 算好,两轮共用(折叠框不入 rects;computeGroupBounds 自带兜底)。
  const rects = new Map<string, GroupBounds>();
  for (const g of groups) {
    if (g.collapsed) continue;
    const rect = computeGroupBounds(g, cards);
    if (rect) rects.set(g.id, rect);
  }

  const owner = new Map<string, string>();
  const sticky = new Set<string>();

  // 轮1:成员粘性 —— 既有成员只要没离开自己的框,就留在原框,不被重叠的上层框吸走。
  for (const g of groups) {
    const rect = rects.get(g.id);
    if (!rect) continue;
    for (const cid of g.cardIds) {
      if (frozen.has(cid) || sticky.has(cid)) continue;
      const c = cards.get(cid);
      if (c && centerInRect(c, rect)) {
        owner.set(cid, g.id);
        sticky.add(cid);
      }
    }
  }

  // 轮2:空间吸收 —— 只认还无主的自由卡;最上层框赢(后者覆盖前者)。
  for (const g of groups) {
    const rect = rects.get(g.id);
    if (!rect) continue;
    for (const cid of cardsInFrame(rect, cards)) {
      if (frozen.has(cid) || sticky.has(cid)) continue;
      owner.set(cid, g.id);
    }
  }

  // 为每个展开框组装新成员:保持已有顺序在前、新增追加(减少 cardIds 顺序 churn)。
  let changed = false;
  for (const g of groups) {
    if (g.collapsed) continue;
    const desired = new Set<string>();
    for (const [cid, gid] of owner) if (gid === g.id) desired.add(cid);

    const next: string[] = [];
    for (const cid of g.cardIds) {
      if (desired.has(cid)) {
        next.push(cid);
        desired.delete(cid);
      }
    }
    for (const cid of desired) next.push(cid);

    const sameAsBefore =
      next.length === g.cardIds.length &&
      next.every((cid, i) => cid === g.cardIds[i]);
    if (!sameAsBefore) {
      // updateGroup 内部 maintainSingleMembership 会把这些卡从其它框挤出 —— 与本处
      // 已算出的「单一归属」一致,无冲突。空框不删除(Frame 模型允许空容器存在)。
      groupStore.updateGroup(g.id, { cardIds: next });
      changed = true;
    }
  }

  if (changed) {
    // 全量落库本项目的组:reconcile 可能经 maintainSingleMembership 顺带改了其它框,
    // 组数量小,整批保存最稳妥(与 groupActions 一致)。
    const all = groupStore.getGroupsByProject(projectId);
    void saveGroupsBatch(all.map(groupToRow)).catch((e) =>
      console.warn("[frameMembership] reconcile persist failed:", e),
    );
  }
  return changed;
}

// ───────────────────────────────────────────────────────────────────────────
// 自动校准 —— 成员归属的「自维护」机制(卡侧的统一权威入口)
// ───────────────────────────────────────────────────────────────────────────

const pendingReconcileProjects = new Set<string>();
let reconcileFlushScheduled = false;

/**
 * 调度一次成员校准:**微任务去抖 + 按项目合并**。同一 tick 内多次卡片几何提交
 * (批量建卡 / 多次 updateCard / 粘贴一串卡)只在 tick 末跑**一次** reconcile。
 *
 * 去抖到微任务而非定时器:微任务在当前同步任务末、下一次用户可感知动作/重绘**之前**
 * 执行,所以「改完即读」的 UI(成员角标 / 折叠)拿到的已是新值,体感等同同步,却把
 * 一连串提交合并成一次 O(框×卡) 计算。
 */
export function scheduleFrameMembershipReconcile(projectId: string): void {
  if (!projectId) return;
  pendingReconcileProjects.add(projectId);
  if (reconcileFlushScheduled) return;
  reconcileFlushScheduled = true;
  queueMicrotask(() => {
    reconcileFlushScheduled = false;
    const ids = [...pendingReconcileProjects];
    pendingReconcileProjects.clear();
    for (const pid of ids) reconcileFrameMembership(pid);
  });
}

let autoReconcileUnsub: (() => void) | null = null;

/**
 * 安装「成员归属自动校准」:订阅 `cardStore.layoutVersion`(卡片几何/增删的唯一信号),
 * 任何卡片移动 / 新建 / 删除 / 缩放 / 粘贴 / 排版 / 程序化 / agent 改动后,**自动**调度
 * 一次当前项目的成员校准。这是**卡侧几何变更的权威 reconcile 入口** —— 有了它,新增
 * 几何路径无需再记得手动 reconcile,空间真相与 `cardIds` 缓存自动收敛。
 *
 * 为何只订 `layoutVersion`、不订 `groupStore`:reconcile 自身经 updateGroup 写 group
 * (bump groupStore.version)但**从不写 cards**(不动 layoutVersion),故本订阅不会被
 * reconcile 自激,无需重入保护。框侧几何(移框/缩放框)订阅看不见,由那两处显式同步
 * reconcile(见本文件头部契约)。
 *
 * 幂等:重复调用只装一次。应用启动 / 项目装载时调一次即可(见 useProjectLifecycle)。
 * 返回卸载函数(供测试 / HMR 清理)。
 */
export function installFrameMembershipAutoReconcile(): () => void {
  if (autoReconcileUnsub) return autoReconcileUnsub;
  const unsub = useCardStore.subscribe((state, prev) => {
    if (state.layoutVersion === prev.layoutVersion) return;
    const pid = useProjectStore.getState().currentProjectId;
    if (pid) scheduleFrameMembershipReconcile(pid);
  });
  autoReconcileUnsub = () => {
    unsub();
    autoReconcileUnsub = null;
  };
  return autoReconcileUnsub;
}
