import { aiProxy, saveMedia } from "@/platform";
import { waitForTask } from "@/services/tasks";
import { throwIfError } from "../errors";
import {
  splitModelFallbacks,
  isRouteUnconfiguredResponse,
  applyModelFallback,
} from "./modelFallback";
import { makeSmoothProgressTracker } from "./progress";
import type { GenerationProgress } from "../types";
import { getComflyKeyTag } from "../comfly/models";
import { taskManager } from "@/services/taskManager";
import { NO_RESULT_URL_MESSAGE } from "@/services/taskOutcome";
import type { AsyncTask } from "@/types";

/**
 * 异步媒体任务统一执行器。
 *
 * 两条路径：
 *
 *   A. **TaskManager 路径**（推荐）：当 `cardId` 提供时启用。任务先落 SQLite，
 *      之后状态机驱动 submit/poll/finalize，每次状态转换都写穿。崩溃/断网/切
 *      项目都可以 resume。**polling 阶段的 UI 进度由 `taskBridge` 统一产出**
 *      （内置时间外推 + 500ms tick），这里只在 submit 之前 emit 一次占位文案。
 *
 *   B. **Legacy 直连路径**：没有 cardId 时（chatStore / agent tools 等场景）走
 *      老的 `aiProxy + waitForTask`，不持久化。`task_id` 一断网就丢，这是已知
 *      限制 —— 这条路径只服务于"一次性、无卡片归属"的调用。没有 store /
 *      taskBridge 接管，所以仍用 `makeSmoothProgressTracker` 做时间外推。
 *
 * 想自定义某一步：传入对应的可选回调（extractTaskId / trySyncResult）。
 * 注意：TaskManager 路径下，trySyncResult 来自 provider 注册时的 handler，
 * 这里传入的 extractTaskId 仅 legacy 路径生效；TaskManager 路径用 handler 内置的提取逻辑。
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
   * 自定义 task_id 提取（仅 legacy 直连路径生效）。默认顺序：
   * 1. 原始 body 上的 `"task_id":<数字>` 正则（保留精度）
   * 2. `data.task_id`（String 化）
   * 3. `data.id`（Seedance 等用 id 的形态）
   */
  extractTaskId?: (rawBody: string, data: unknown) => string | null;
  /**
   * 同步快路径（仅 legacy 直连路径生效；TaskManager 路径由 provider 注册的 handler 处理）。
   */
  trySyncResult?: (data: unknown) => SyncResult | null;
  /**
   * 卡片 ID。**提供时启用 TaskManager 路径**（落库、可恢复、可重试）。
   * 不提供时走 legacy 直连路径。
   */
  cardId?: string;
  /**
   * 任务类型。配合 `cardId` 决定 TaskManager 使用哪个 handler。
   * 默认 "image_gen"。
   */
  kind?: "image_gen" | "video_gen" | "audio_gen";
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
  if (req.cardId) {
    return await executeViaTaskManager(req);
  }
  return await executeLegacyDirectly(req);
}

// ────────────────────────────────────────────────────────────────
// 路径 A：TaskManager（持久化 + 可恢复）
// ────────────────────────────────────────────────────────────────

async function executeViaTaskManager(
  req: AsyncMediaTaskRequest,
): Promise<AsyncMediaTaskResult> {
  const kind = req.kind ?? "image_gen";

  if (!taskManager.hasHandler(req.providerId, kind)) {
    // Provider 尚未注册 media handler —— 安全降级走 legacy 路径，
    // 同时打个 warn 让开发期能发现没注册的 provider。
    console.warn(
      `[asyncMediaTask] no TaskManager handler for ${req.providerId}:${kind}, falling back to legacy path`,
    );
    return await executeLegacyDirectly(req);
  }

  const keyTag =
    req.providerId === "comfly"
      ? getComflyKeyTag(typeof req.body.model === "string" ? req.body.model : undefined)
      : undefined;

  // TaskManager 路径下，**polling 阶段的 UI 进度由 taskBridge 统一产出**
  // （内置时间外推 + 500ms tick），这里不再额外订阅 store。
  //
  // emit 仍然在 submit 之前发一次"正在提交请求…" —— 编辑器在等 task 真正落到
  // store 之前的那一瞬，UI 上有个明确的占位文案。task 一旦进入 store，
  // taskBridge 立刻接管覆盖。
  const submittingLabel = req.submittingLabel ?? "正在提交请求…";
  req.emit?.({ percent: 0, phase: "submitting", label: submittingLabel });

  const { completion } = await taskManager.startTask({
    cardId: req.cardId!,
    projectId: req.projectId ?? "",
    provider: req.providerId,
    kind,
    submitEndpoint: req.submitEndpoint,
    pollEndpoint: req.pollEndpoint,
    request: req.body,
    keyTag,
  });

  const finalTask = await completion;
  return extractMediaResult(finalTask, req);
}

function extractMediaResult(
  finalTask: AsyncTask,
  req: AsyncMediaTaskRequest,
): AsyncMediaTaskResult {
  if (finalTask.status === "success" && finalTask.result) {
    const r = finalTask.result;
    const url = typeof r.url === "string" ? r.url : "";
    if (!url) {
      throw new Error(req.failedFallbackMessage ?? NO_RESULT_URL_MESSAGE);
    }
    return {
      url,
      revisedPrompt:
        typeof r.revisedPrompt === "string" ? r.revisedPrompt : undefined,
    };
  }

  if (finalTask.status === "canceled") {
    throw new DOMException("canceled", "AbortError");
  }

  // failed
  const msg =
    finalTask.errorMessage ?? req.failedFallbackMessage ?? "任务失败";
  throw new Error(msg);
}

// ────────────────────────────────────────────────────────────────
// 路径 B：Legacy 直连（chatStore / agent tools 等无卡片归属调用走这里）
// ────────────────────────────────────────────────────────────────

async function executeLegacyDirectly(
  req: AsyncMediaTaskRequest,
): Promise<AsyncMediaTaskResult> {
  const emit = req.emit;
  const submittingLabel = req.submittingLabel ?? "正在提交请求…";
  const savingLabel = req.savingLabel ?? "正在保存…";
  const failedFallback = req.failedFallbackMessage ?? "任务失败";

  emit?.({ percent: 0, phase: "submitting", label: submittingLabel });

  const { body, fallbacks } = splitModelFallbacks(req.body);
  let raw = await aiProxy(req.providerId, req.submitEndpoint, body);
  // 「模型未配置路由」(SKU 被关停)→ 静默降级重发,与 TaskManager 路径(mediaHandler)同款。
  for (const fb of fallbacks) {
    if (!isRouteUnconfiguredResponse(raw)) break;
    raw = await aiProxy(req.providerId, req.submitEndpoint, applyModelFallback(body, fb));
  }
  throwIfError(raw.status, raw.body);

  const data = JSON.parse(raw.body) as unknown;

  if (req.trySyncResult) {
    const sync = req.trySyncResult(data);
    if (sync) {
      emit?.({ percent: 80, phase: "saving", label: savingLabel });
      return await saveAndReturn(sync.url, req.projectId, req.title, emit, sync.revisedPrompt);
    }
  }

  const extract = req.extractTaskId ?? defaultExtractTaskId;
  const taskId = extract(raw.body, data);
  if (!taskId) throw new Error("未能从响应中获取任务 ID");

  emit?.({ percent: 5, phase: "queued", label: "已提交，排队中…" });

  const pollKeyTag =
    req.providerId === "comfly"
      ? getComflyKeyTag(typeof req.body.model === "string" ? req.body.model : undefined)
      : undefined;

  const result = await waitForTask(
    String(taskId),
    makeSmoothProgressTracker(emit, {
      expectedSec: req.expectedSec,
      generatingLabel: req.generatingLabel,
    }),
    undefined,
    req.pollEndpoint,
    req.providerId,
    pollKeyTag,
  );

  const status = result.status.toLowerCase();
  if (status === "failed" || status === "error" || status === "cancelled" || status === "expired") {
    throw new Error(result.errorMessage || failedFallback);
  }
  if (!result.resultUrl) throw new Error(NO_RESULT_URL_MESSAGE);

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

