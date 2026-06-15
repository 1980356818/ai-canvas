/**
 * 组运行控制器 —— 一个正在跑的组的「控制意图」真相源。
 *
 * 把「控制意图」(停止 / 强制中止 / 未来的暂停)从「调度机制」(executor 的循环)里
 * 剥离:executor 只在派发咽喉处 consult 本对象,**不**在循环里散落 if 标志位。控制态
 * 集中一处,新增控制语义不波及调度骨架。
 *
 * ─── 两种停法,语义严格区分 ────────────────────────────────────
 *  • {@link GroupRunControl.requestStop} = **排空式停止**(graceful,用户点「停止」的默认):
 *      - 已过提交咽喉、在途的卡 → executor 的闸门在它「之前」,碰不到它 → 跑到落戳
 *        (钱已花,结果要留);
 *      - 未派发的卡(后续层 / 本层并发池里还没轮到的)→ 闸门拦死,不发(不扣费)。
 *  • {@link GroupRunControl.forceAbort} = **强制中止**(escalation,极少用):
 *      在 requestStop 的基础上 abort {@link GroupRunControl.signal},该信号透传进
 *      `runCard` 把在途的 TaskManager 任务也 kill 掉。仅用于「任务卡死轮询」等救场,
 *      会浪费已扣费的在途工作,故**不作主操作暴露**。
 *
 * ─── 为什么是状态机而非裸 boolean ──────────────────────────────
 *  扩展性:未来要加「暂停 → 继续」,把 state 扩成 `"paused"` 并提供 `await gate()` 即可,
 *  executor 的闸门从同步 `shouldDispatch()` 升级成 `await`,控制态仍集中在这一处,
 *  调度循环只多 await 一下。
 */

export type RunControlState = "running" | "stopping";

export class GroupRunControl {
  private state: RunControlState = "running";

  /**
   * 强制中止信号。**仅** {@link forceAbort} 时 abort;排空式停止不碰它,故 graceful
   * 永远不会 kill 在途。executor 始终把它透传进 `runCard({ signal })`:graceful 下它
   * 永不触发(无害),forceAbort 下它真正中断在途生成。
   */
  private readonly ac = new AbortController();

  get signal(): AbortSignal {
    return this.ac.signal;
  }

  /** 当前是否处于停止流程(graceful 或 force 都置此)。 */
  isStopping(): boolean {
    return this.state === "stopping";
  }

  /**
   * executor 在派发每张「未过咽喉」的卡之前 consult。
   * 返回 false = 别再发新卡(后续层不开、本层未轮到的不发)。在途的不受影响。
   */
  shouldDispatch(): boolean {
    return this.state === "running";
  }

  /** 排空式停止:停派发,在途不动(不 abort signal)。 */
  requestStop(): void {
    this.state = "stopping";
  }

  /** 强制中止:停派发 + abort 在途(救场用,会丢已扣费的在途结果)。 */
  forceAbort(): void {
    this.state = "stopping";
    this.ac.abort();
  }
}

/**
 * 每个组的运行控制器注册表(「一组同时一个运行实例」不变式)。
 * 替代旧 `groupRunner.ts` 的 `Map<groupId, AbortController>` —— 现在持有的是富语义的
 * {@link GroupRunControl}。
 */
const registry = new Map<string, GroupRunControl>();

/** 起新一轮:注册并返回控制器。调用方应先 {@link isRunRegistered} 确认未在跑。 */
export function registerRun(groupId: string): GroupRunControl {
  const control = new GroupRunControl();
  registry.set(groupId, control);
  return control;
}

/** 取该组当前运行的控制器(stopGroup / forceAbortGroup 用)。 */
export function getRun(groupId: string): GroupRunControl | undefined {
  return registry.get(groupId);
}

/**
 * 注销本轮控制器。只删「正是自己这一轮」注册的那个,避免重入场景误删后继的新一轮。
 */
export function unregisterRun(groupId: string, control: GroupRunControl): void {
  if (registry.get(groupId) === control) {
    registry.delete(groupId);
  }
}

/** 该组是否正在运行(注册表里有 = 在跑或收尾中)。门面用它拦重入。 */
export function isRunRegistered(groupId: string): boolean {
  return registry.has(groupId);
}
