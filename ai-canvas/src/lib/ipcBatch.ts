/**
 * 跨 IPC 批量 invoke 守门工具 —— 项目内唯一的"前端 → Rust 批量传输"入口。
 *
 * ## 为什么需要这个
 *
 * Tauri 2 + WebView2 实测单次 invoke 字符串字段超过 ~3MB 就会随机抛
 * `ERR_CONNECTION_REFUSED` / "Failed to fetch"，WebView2 直接终止渲染进程
 * （白屏一闪 → 窗口关闭），Rust 主进程日志干净没线索。详见
 * [`@/lib/ipcLimits`](./ipcLimits.ts) 和 [`project_ai_canvas_crash_fixes.md`]。
 *
 * 任何一次性把多条记录通过 `invoke` 传给后端的命令（save_cards_batch /
 * save_connections / 等），都必须经过本工具，由它按 `IPC_PAYLOAD_HARD_LIMIT_BYTES`
 * 拆批，逐批 invoke。**禁止**在调用方自行 `invoke("save_xxx_batch", { items })`
 * 而不走分批。
 *
 * ## 使用示例
 *
 * ```ts
 * import { invokeBatched } from "@/lib/ipcBatch";
 *
 * await invokeBatched({
 *   command: "save_cards_batch",
 *   items: cards,
 *   buildArgs: (chunk) => ({ cards: chunk }),
 * });
 * ```
 *
 * ## 切片策略
 *
 * 1. 估算单 item 的 JSON 序列化字节数（仅在首批做一次抽样，避免 N 次 stringify）
 * 2. 按 `targetBytesPerBatch`（默认 = HARD_LIMIT × 0.6 = 1.8MB）反推 batch size
 * 3. clamp 到 `[1, maxItemsPerBatch]`（默认 maxItemsPerBatch=500）
 * 4. 单个 item 即超过 HARD_LIMIT 时单独成一批（让后端去拒，不是这里的兜底点）
 *
 * 切片在前端做的好处：失败时知道哪一批挂了；后端不需要懂"上限"。
 */

import { IPC_PAYLOAD_HARD_LIMIT_BYTES } from "@/lib/ipcLimits";
import { getInvoke, ensureTauriAPIs } from "@/platform/runtime";

/** 单批目标字节数；留 40% 余量给 Tauri 自身的 IPC envelope 开销。 */
const TARGET_BYTES_PER_BATCH = Math.floor(IPC_PAYLOAD_HARD_LIMIT_BYTES * 0.6);

/** 即便每条很小也不要在单批塞过多 items —— 后端事务/批 INSERT 也有 SQLite 限制。 */
const DEFAULT_MAX_ITEMS_PER_BATCH = 500;

export interface InvokeBatchedOptions<T> {
  /** Tauri 命令名 */
  command: string;
  /** 要传输的 items（同一种 shape） */
  items: T[];
  /** 把一个 chunk 组装成 invoke 的第二参 */
  buildArgs: (chunk: T[]) => Record<string, unknown>;
  /** 单批最多条目数；默认 500 */
  maxItemsPerBatch?: number;
  /** AbortSignal —— 中途 abort 后续批不再发 */
  signal?: AbortSignal;
  /** 每批完成回调（用于进度提示） */
  onBatch?: (info: { batchIndex: number; batchSize: number; total: number }) => void;
}

/** 估算 JSON 序列化字节数（UTF-8 近似 = JSON 长度 + 多字节字符额外 1-2 字节，统一按 length × 1.2 估）。 */
function estimateBytes(item: unknown): number {
  try {
    const s = JSON.stringify(item);
    return Math.ceil(s.length * 1.2);
  } catch {
    // 不可序列化的 item 本来就会让 invoke 失败，给个保守大值让它单独成批
    return IPC_PAYLOAD_HARD_LIMIT_BYTES;
  }
}

/**
 * 按字节预算把 items 切成若干 chunks。
 * 抽样首条估算单 item 体积，避免对每条都 stringify。
 */
function chunkByBytes<T>(items: T[], maxItemsPerBatch: number): T[][] {
  if (items.length === 0) return [];
  if (items.length === 1) return [items];

  // 抽样 + 取 max（保守）
  const sampleCount = Math.min(items.length, 5);
  let maxSample = 0;
  for (let i = 0; i < sampleCount; i++) {
    const b = estimateBytes(items[i]);
    if (b > maxSample) maxSample = b;
  }
  // sample 全是空 / 极小时，单批塞 maxItemsPerBatch
  const safePerItem = Math.max(1, maxSample);

  const byBytes = Math.max(1, Math.floor(TARGET_BYTES_PER_BATCH / safePerItem));
  const batchSize = Math.min(byBytes, maxItemsPerBatch);

  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    chunks.push(items.slice(i, i + batchSize));
  }
  return chunks;
}

/**
 * 批量 invoke 一个 Tauri 命令，自动分批、自动尊重 AbortSignal。
 *
 * - items 为空时直接 resolve，不发任何 invoke
 * - 单批失败立即抛错；已发送的批由后端决定是否回滚（通常各批独立事务）
 * - signal abort 后立刻停止后续批
 */
export async function invokeBatched<T>(opts: InvokeBatchedOptions<T>): Promise<void> {
  const {
    command,
    items,
    buildArgs,
    maxItemsPerBatch = DEFAULT_MAX_ITEMS_PER_BATCH,
    signal,
    onBatch,
  } = opts;

  if (items.length === 0) return;
  if (signal?.aborted) throw new Error("Aborted");

  await ensureTauriAPIs();
  const invoke = getInvoke();

  const chunks = chunkByBytes(items, maxItemsPerBatch);
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) throw new Error("Aborted");
    const chunk = chunks[i]!;
    await invoke(command, buildArgs(chunk));
    onBatch?.({ batchIndex: i, batchSize: chunk.length, total: chunks.length });
  }
}
