import { pollTask } from "@/platform";
import type { TaskInfo } from "@/types";

export type { TaskResult } from "@/types";

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "error",
  "success",
  "succeeded",
  "expired",
]);

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status.toLowerCase());
}

const INITIAL_DELAY = 1000;
const MAX_DELAY = 10000;
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
): Promise<TaskResult> {
  let delay = INITIAL_DELAY;

  for (;;) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const info: TaskInfo = await pollTask(taskId, endpoint);

    onProgress?.(info.progress ?? 0, info.status);

    if (isTerminal(info.status)) {
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
