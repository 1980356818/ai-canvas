import { pollTask } from "@/platform";
import type { TaskInfo, TaskResult } from "@/types";
import { classifyTaskInfo, MAX_EMPTY_SUCCESS_POLLS } from "@/services/taskOutcome";

export type { TaskResult } from "@/types";

const INITIAL_DELAY = 1000;
const MAX_DELAY = 3000;
const BACKOFF_FACTOR = 2;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export async function waitForTask(
  taskId: string,
  onProgress?: (progress: number, status: string) => void,
  signal?: AbortSignal,
  endpoint?: string,
  provider?: string,
  keyTag?: string,
): Promise<TaskResult> {
  let delay = INITIAL_DELAY;
  const startMs = Date.now();
  let pollCount = 0;
  let emptySuccessPolls = 0;

  for (;;) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const pollStartMs = Date.now();
    const info: TaskInfo = await pollTask(taskId, endpoint, provider, keyTag);
    const httpMs = Date.now() - pollStartMs;
    pollCount += 1;
    console.log(
      `[task] poll #${pollCount} taskId=${taskId} httpMs=${httpMs} status=${info.status} progress=${info.progress ?? 0} totalMs=${Date.now() - startMs}`,
    );

    onProgress?.(info.progress ?? 0, info.status);

    const cls = classifyTaskInfo(info);

    // 成功态但 URL 未就绪:服务端"状态先翻、结果 URL 稍后落库"的偶发窗口,不是真完成。
    // 继续轮询(有上限),避免误报"任务完成但未返回结果地址"。
    if (cls.kind === "awaiting_url" && emptySuccessPolls < MAX_EMPTY_SUCCESS_POLLS) {
      emptySuccessPolls += 1;
      await sleep(delay, signal);
      delay = Math.min(delay * BACKOFF_FACTOR, MAX_DELAY);
      continue;
    }

    // success / failed / 宽限耗尽的 awaiting_url 都按终态返回(原样透传 info;宽限耗尽时
    // resultUrl 仍为空,交由上层 executeLegacyDirectly 报"未返回结果地址")。
    if (cls.kind !== "pending") {
      console.log(
        `[task] done taskId=${taskId} polls=${pollCount} totalMs=${Date.now() - startMs} status=${info.status}`,
      );
      return {
        status: info.status,
        resultUrl: info.resultUrl,
        thumbnailUrl: info.thumbnailUrl,
        errorMessage: info.errorMessage,
      };
    }

    await sleep(delay, signal);
    delay = Math.min(delay * BACKOFF_FACTOR, MAX_DELAY);
  }
}
