import { pollTask, type TaskInfo } from "@/lib/tauri";

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "error",
  "success",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "ERROR",
  "SUCCESS",
]);

const INITIAL_DELAY = 1000;
const MAX_DELAY = 10000;
const BACKOFF_FACTOR = 2;

export interface TaskResult {
  status: string;
  resultUrl?: string;
  thumbnailUrl?: string;
  errorMessage?: string;
}

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
): Promise<TaskResult> {
  let delay = INITIAL_DELAY;

  for (;;) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const info: TaskInfo = await pollTask(taskId);

    onProgress?.(info.progress ?? 0, info.status);

    if (TERMINAL_STATUSES.has(info.status)) {
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
