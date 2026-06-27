/**
 * 异步媒体任务「轮询结果分类」的唯一真相源。
 *
 * 所有轮询路径都必须经由这里判定状态 —— 包括:
 *   - TaskManager 的 `mediaHandler.pollMedia`(持久化路径)
 *   - legacy 直连的 `services/tasks.ts::waitForTask`(chat / agent 路径)
 *
 * 严禁各路径再各自维护一份 success/failed 状态集或「成功态无 URL」的处理策略,
 * 否则极境收尾窗口的偶发误报会从某条没改到的路径漏回来。
 *
 * ── 为什么需要 awaiting_url ──
 * 极境任务收尾存在一个毫秒~数秒窗口:任务「状态已翻 success」但「结果 URL 尚未
 * 落库 / 转存 CDN 完成」。此刻恰好 poll 到 → 拿到「成功态 + 空 URL」。这**不是**
 * 失败,继续轮询即可拿到 URL。旧实现把它当永久失败,导致偶发误报
 * 「{@link NO_RESULT_URL_MESSAGE}」(图片 / 视频都中招)。
 */
import type { TaskInfo } from "@/types";

/** 终态成功(已产出结果)。 */
export const SUCCESS_STATUSES = new Set(["completed", "success", "succeeded"]);

/** 终态失败。 */
export const FAILED_STATUSES = new Set([
  "failed",
  "error",
  "cancelled",
  "canceled",
  "expired",
]);

/** 成功态但 URL 缺失、宽限轮询耗尽后,给用户的兜底文案。 */
export const NO_RESULT_URL_MESSAGE = "任务完成但未返回结果地址";

/** 失败但上游没给原因时的兜底文案。 */
export const TASK_FAILED_MESSAGE = "任务失败";

/**
 * 「被替换」良性信号:用户在生成中又点了「重新生成」,旧任务被新尝试取代。
 *
 * 旧任务已计费,会在后台跑完、结果只进任务面板(不写画布)。编辑器 / 组运行
 * 那条 `await` 路径检出它后**静默吞掉**(不报错、不写卡)——因为画布卡此刻已由
 * 新当前任务接管。详见 docs/卡片任务面板-生成尝试可观测与可恢复-设计施工图.md §写闸门。
 */
export class SupersededError extends Error {
  constructor(message = "任务已被新的生成尝试取代") {
    super(message);
    this.name = "SupersededError";
  }
}

/**
 * 成功态但结果 URL 尚未就绪时,允许的最大额外轮询次数。
 *
 * 配合轮询退避(1s→10s),~10 次约 75s 宽限,足够覆盖极境的落库 / 转存 CDN 窗口;
 * 真超出才判定确实没产出,沿用 {@link NO_RESULT_URL_MESSAGE}。
 */
export const MAX_EMPTY_SUCCESS_POLLS = 10;

export type TaskClassification =
  /** 终态成功且 URL 就绪。 */
  | { kind: "success"; url: string; thumbnailUrl?: string }
  /** 终态失败。 */
  | { kind: "failed"; message: string }
  /** 成功态但 URL 未就绪 —— 应继续轮询(调用方按 {@link MAX_EMPTY_SUCCESS_POLLS} 设上限)。 */
  | { kind: "awaiting_url" }
  /** 仍在进行中(非终态)。 */
  | { kind: "pending" };

/**
 * 把一次轮询拿到的 {@link TaskInfo} 归一成统一分类。
 *
 * 无副作用、不计数 ——「宽限上限」的计数由各调用方自己维护(它们的轮询循环结构不同),
 * 但「什么算成功 / 失败 / 应继续轮询」的判定只此一处。
 */
export function classifyTaskInfo(info: TaskInfo): TaskClassification {
  const status = (info.status || "").toLowerCase();

  if (SUCCESS_STATUSES.has(status)) {
    if (!info.resultUrl) return { kind: "awaiting_url" };
    return { kind: "success", url: info.resultUrl, thumbnailUrl: info.thumbnailUrl };
  }

  if (FAILED_STATUSES.has(status)) {
    return { kind: "failed", message: info.errorMessage || TASK_FAILED_MESSAGE };
  }

  return { kind: "pending" };
}

/**
 * 状态是否为终态(成功或失败)。
 *
 * 注意:它只看 `status` 字符串。「成功态但 URL 未就绪」在 {@link classifyTaskInfo}
 * 里归为 `awaiting_url`(需继续轮询),而非这里的终态 —— 想区分两者请用 classify。
 */
export function isTerminalStatus(status: string): boolean {
  const s = (status || "").toLowerCase();
  return SUCCESS_STATUSES.has(s) || FAILED_STATUSES.has(s);
}
