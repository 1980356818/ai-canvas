import { aiProxy, saveMedia } from "@/platform";
import { waitForTask } from "@/services/tasks";
import { throwIfError } from "../errors";
import { makeSmoothProgressTracker } from "./progress";
import type { GenerationProgress } from "../types";

/**
 * 异步媒体任务统一执行器。
 *
 * 所有"提交 → 轮询 → 保存"型的上游媒体接口（图像 / 视频 / 音频）走同一条
 * 流水线。各 provider 只负责拼请求体和给经验时长，剩下的 submit/extract
 * /poll/save 全部由本函数统一处理：
 *
 *   1. emit submitting
 *   2. aiProxy POST 到 submitEndpoint
 *   3. throwIfError（统一翻译 4xx/5xx 为 ApiError）
 *   4. 提取 task_id：优先从原始 body 抓字符串（保留 Snowflake 精度），其次 data.task_id / data.id
 *   5. (可选) 同步快路径：trySyncResult 返回 URL 时跳过轮询
 *   6. emit queued
 *   7. waitForTask + makeSmoothProgressTracker（时间外推平滑进度）
 *   8. 终止状态判定 + 错误抛出
 *   9. emit saving
 *  10. saveMedia 到本地（失败兜底返回远端 URL）
 *
 * 想自定义某一步：传入对应的可选回调（extractTaskId / trySyncResult）。
 */

export interface AsyncMediaTaskRequest {
  /** Provider id 传给 aiProxy（"comfly", "jijing", 等）。 */
  providerId: string;
  /** 任务提交端点。 */
  submitEndpoint: string;
  /** 已拼装好的请求体。 */
  body: Record<string, unknown>;
  /** 进度回调。 */
  emit?: (p: GenerationProgress) => void;
  /** 轮询端点模板（如 `/seedance/v3/.../{task_id}`），不传则用平台默认。 */
  pollEndpoint?: string;
  /** 时间外推用的预期任务时长（秒）。 */
  expectedSec: number;
  /** generating 阶段文案，默认 "生成中…"。 */
  generatingLabel?: string;
  /** 任务归属的 projectId，传给 saveMedia 用作目录隔离。 */
  projectId?: string;
  /** 媒体保存时的 title（一般传 prompt 用作文件标题/元数据）。 */
  title?: string;
  /** submitting 阶段文案。 */
  submittingLabel?: string;
  /** saving 阶段文案。 */
  savingLabel?: string;
  /** 终止失败时的兜底错误文案。 */
  failedFallbackMessage?: string;
  /**
   * 自定义 task_id 提取。默认顺序：
   * 1. 原始 body 上的 `"task_id":<数字>` 正则（保留精度）
   * 2. `data.task_id`（String 化）
   * 3. `data.id`（Seedance 等用 id 的形态）
   */
  extractTaskId?: (rawBody: string, data: unknown) => string | null;
  /**
   * 同步快路径：图像 API 偶尔会直接返回 URL（如 OpenAI `data[0].url`），
   * 返回 URL 时跳过轮询，直接走保存路径。
   */
  trySyncResult?: (data: unknown) => SyncResult | null;
}

export interface SyncResult {
  url: string;
  revisedPrompt?: string;
}

export interface AsyncMediaTaskResult {
  url: string;
  revisedPrompt?: string;
}

const TASK_ID_REGEX = /"task_id"\s*:\s*"?(\d+)"?/;

function defaultExtractTaskId(rawBody: string, data: unknown): string | null {
  const match = rawBody.match(TASK_ID_REGEX);
  if (match) return match[1]!;
  const d = data as { task_id?: unknown; id?: unknown } | null | undefined;
  if (d?.task_id != null) return String(d.task_id);
  if (d?.id != null) return String(d.id);
  return null;
}

export async function executeAsyncMediaTask(
  req: AsyncMediaTaskRequest,
): Promise<AsyncMediaTaskResult> {
  const emit = req.emit;
  const submittingLabel = req.submittingLabel ?? "正在提交请求…";
  const savingLabel = req.savingLabel ?? "正在保存…";
  const failedFallback = req.failedFallbackMessage ?? "任务失败";

  emit?.({ percent: 0, phase: "submitting", label: submittingLabel });

  const raw = await aiProxy(req.providerId, req.submitEndpoint, req.body);
  throwIfError(raw.status, raw.body);

  const data = JSON.parse(raw.body) as unknown;

  // 同步快路径
  if (req.trySyncResult) {
    const sync = req.trySyncResult(data);
    if (sync) {
      emit?.({ percent: 80, phase: "saving", label: savingLabel });
      return await saveAndReturn(sync.url, req.projectId, req.title, emit, sync.revisedPrompt);
    }
  }

  // 异步轮询路径
  const extract = req.extractTaskId ?? defaultExtractTaskId;
  const taskId = extract(raw.body, data);
  if (!taskId) throw new Error("未能从响应中获取任务 ID");

  emit?.({ percent: 5, phase: "queued", label: "已提交，排队中…" });

  const result = await waitForTask(
    String(taskId),
    makeSmoothProgressTracker(emit, {
      expectedSec: req.expectedSec,
      generatingLabel: req.generatingLabel,
    }),
    undefined,
    req.pollEndpoint,
    req.providerId,
  );

  const status = result.status.toLowerCase();
  if (status === "failed" || status === "error" || status === "cancelled" || status === "expired") {
    throw new Error(result.errorMessage || failedFallback);
  }
  if (!result.resultUrl) throw new Error("任务完成但未返回结果地址");

  emit?.({ percent: 92, phase: "saving", label: savingLabel });
  return await saveAndReturn(result.resultUrl, req.projectId, req.title, emit);
}

async function saveAndReturn(
  remoteUrl: string,
  projectId: string | undefined,
  title: string | undefined,
  emit: ((p: GenerationProgress) => void) | undefined,
  revisedPrompt?: string,
): Promise<AsyncMediaTaskResult> {
  try {
    const saved = await saveMedia(remoteUrl, undefined, title, projectId);
    emit?.({ percent: 100, phase: "saving", label: "完成" });
    return revisedPrompt != null
      ? { url: saved.localPath, revisedPrompt }
      : { url: saved.localPath };
  } catch {
    emit?.({ percent: 100, phase: "saving", label: "完成（使用远程地址）" });
    return revisedPrompt != null
      ? { url: remoteUrl, revisedPrompt }
      : { url: remoteUrl };
  }
}
