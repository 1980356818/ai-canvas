/**
 * 组运行的统一返回类型与处置(outcome)词表 —— 规范化的单一真相源。
 *
 * plan / executor / 门面(index)共享这一套语义,不各自定义结构;改返回形状只动这里。
 */

import type { RunCardOutcome } from "@/services/cardRunner";

/**
 * 单卡在组运行里的处置。比 cardRunner 的 {@link RunCardOutcome} 多一个 `"not-dispatched"`:
 *   - `ok` / `skipped` / `failed` —— 真跑过 `runCard` 得到的结果(同 RunCardOutcome);
 *   - `not-dispatched` —— 因**停止闸门**或**失败隔离剪枝**,这张卡根本没派发:
 *      没过提交咽喉、**没扣费**。这是组调度层独有的概念,cardRunner 不产生它。
 *
 * 关键区分:`not-dispatched`(没发,没花钱)≠ `skipped`(发了 runCard 但按类型/前置
 * 条件合理跳过,如 text 节点 / resume 新鲜卡)。两者计数分开,账目才清。
 */
export type GroupCardOutcome = RunCardOutcome | "not-dispatched";

/**
 * 组运行的终结态,与 {@link GroupRunPhase} 的终态一一对应:
 *   - `completed` —— 范围内该跑的都跑完了;
 *   - `stopped`   —— 用户排空式停止(在途跑完落戳,未派发的截断);
 *   - `failed`    —— 某卡失败触发 fail-fast(P3 改为失败隔离后,仍以此态收尾)。
 */
export type RunGroupEndState = "completed" | "stopped" | "failed";

/** 门面 `runGroup()` 的对外返回。账目守恒:ok + skipped + failed + notDispatched = total。 */
export interface RunGroupResult {
  groupId: string;
  /** 成功落结果的卡数。 */
  ok: number;
  /** 发了 runCard 但合理跳过的卡数(text/sticky/audio、缺 prompt、resume 新鲜卡)。 */
  skipped: number;
  /** 失败的卡数。 */
  failed: number;
  /** 因停止/剪枝未派发的卡数(未过咽喉、未扣费)。 */
  notDispatched: number;
  /** 是否真正进入调度。false = 前置失败(组不存在/空/成环/范围空),未跑任何卡。 */
  ran: boolean;
  /** 终结态;`ran === false` 时为 undefined。 */
  endState?: RunGroupEndState;
}

/**
 * 失败是否可重试。**保守**:只在「请求被拒 / 没发出去 = 没扣费」时才重试,绝不重试
 * 可能已扣费的失败(超时/上游生成错误),与排空式停止同款计费洁癖 —— 重试已计费的
 * 在途失败 = 重复扣费。
 *   可重试:限流(429 / rate limit / too many / 频繁 / 请求过多)、
 *           网络发送失败(econnrefused / enotfound / fetch failed / 连接失败 / 网络错误 / 发送失败)。
 *   不重试:超时(可能已处理已计费)、内容审核、参数非法、余额不足、其余上游错误。
 */
export function isRetryableFailure(reason: string): boolean {
  const r = reason.toLowerCase();
  return (
    /(^|\D)429(\D|$)|rate.?limit|too many|频繁|请求过多/.test(r) ||
    /econnrefused|enotfound|fetch failed|network error|连接失败|网络错误|发送失败|无法连接/.test(r)
  );
}

/** executor 回给门面的执行报告(门面据此出 toast + 收尾)。 */
export interface ExecutionReport {
  ok: number;
  skipped: number;
  failed: number;
  notDispatched: number;
  endState: RunGroupEndState;
  /** 首个失败卡(fail-fast 锚点);用于门面 toast 与 status.fail。无失败为 null。 */
  firstFailure: { cardId: string; reason: string } | null;
}
