/**
 * 并发上限的 Promise 池：一次最多跑 `limit` 个 task，其它排队。
 *
 * 用途：批量图片生成、HEIC 批量转换、批量 IPC 调用之类。无界并发会
 * 在 WebView2 上累积大图 RGBA bitmap，逼近 GPU 内存上限导致渲染端崩溃。
 *
 * 行为：
 *   - 跟 `Promise.allSettled` 同语义返回 `PromiseSettledResult<T>[]`，调用方拿原下标对应结果
 *   - 任一任务抛错被 settled 捕获，不影响其余任务继续跑
 *   - 顺序：发起按下标顺序，完成顺序由各 task 实际耗时决定
 */
export async function runWithLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const effective = Math.max(1, Math.floor(limit));
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= tasks.length) return;
      try {
        const value = await tasks[i]!();
        results[i] = { status: "fulfilled", value };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(effective, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
