/**
 * Task → UI 桥接器（**polling 阶段唯一的 UI 进度产出源**）。
 *
 * 把 tasksStore 的状态机变化映射到 UI 层的两个地方：
 *   1. uiStore.generatingCards / cardErrors  ——  进度条 / 错误 UI
 *   2. cardStore card.data.{imageUrl|videoUrl|...}  ——  成功结果落到对应字段
 *
 * ## 为什么这层要兜底 polling 进度
 *
 * 上游（极境/Sub2API 等）经常在轮询响应里**不报真实 progress**：要么字段缺失、
 * 要么常驻 0、要么直接跳 0 → 100，没有中间值。客户端如果照单全收就会卡死在
 * "生成中 0%"。所以桥接器在 polling 阶段：
 *   - **有真实 progress（>0）** → 直接展示
 *   - **没有真实 progress** → 按经过时间外推（10% → 90% 在 `expectedSec` 内线性爬）
 *
 * 此外，桥接器跑一个 **500ms 定时 tick** 重算 polling 任务的展示百分比 ——
 * 否则 store 在两次 poll 之间没有变化，UI 也会卡格。
 *
 * ## 为什么不在 TaskManager 直接写 UI
 *   - TaskManager 不应该认识 React 组件 / 卡片数据结构
 *   - **resumed 任务**（崩溃恢复后）没有原始 await 流程，桥接器是唯一写回路径
 *
 * 安装一次（在 useProjectLifecycle 的 init 阶段）即可。返回的 unsubscribe 用于卸载。
 */

import { useTasksStore } from "@/stores/tasksStore";
import { useUIStore } from "@/stores/uiStore";
import { useCardStore } from "@/stores/cardStore";
import { autoSave } from "@/lib/autoSave";
import type { AsyncTask, CanvasCard, TaskStatus } from "@/types";
import type { CardGenProgress } from "@/types/ui";

// ────────────────────────────────────────────────────────────────
// 时间外推参数
// ────────────────────────────────────────────────────────────────

/** generating 阶段 UI 起点，避免一开始就显示 0%。 */
const START_PERCENT = 10;
/** generating 阶段外推上限；真完成时一次性跳 100。 */
const CEILING_PERCENT = 90;
/** 进入"正在保存…"文案的真实进度阈值（仅在上游真报 >=90 时触发）。 */
const SAVING_THRESHOLD = 90;
/** tick 间隔；500ms 在视觉上接近平滑、CPU 占用可忽略。 */
const TICK_INTERVAL_MS = 500;

/**
 * task.kind + request.model 推断的预期任务时长（秒）。
 *
 * 数值参考极境实测：
 *   - gpt-image-2-2k / nano-banana-pro-2k / 普通 image  → 60s
 *   - gpt-image-2-4k                                   → 150s
 *   - Veo / pro 视频 / Seedance 视频                    → 180s
 *
 * 这个值只影响"时间外推爬到 90% 的速度"——估高了用户会等到真完成时跳一下，
 * 估低了会卡 90% 等真完成。宁可估高也不要估低。
 */
function inferExpectedSec(task: AsyncTask): number {
  const model = String(
    (task.request as Record<string, unknown> | undefined)?.model ?? "",
  ).toLowerCase();

  if (task.kind === "video_gen") return 180;
  if (task.kind === "image_gen") {
    if (model.includes("4k")) return 150;
    return 60;
  }
  return 60;
}

// ────────────────────────────────────────────────────────────────
// 内部状态
// ────────────────────────────────────────────────────────────────

interface ProgressTracker {
  /** 第一次进入 polling 的时间戳。用作时间外推基线。 */
  startedAtMs: number;
  /** 上一次外推/写入的百分比，用于单调递增。 */
  lastPercent: number;
  /** 推断出来的预期时长（秒）。 */
  expectedSec: number;
}

const trackers = new Map<string, ProgressTracker>();
/** 终态消费过的任务 id（避免重复写 card.data）。 */
const consumedTerminal = new Set<string>();
/**
 * 上次写到 UI 的 (percent, label) 组合。
 * 既给 store 订阅去重，也给定时 tick 去重 —— 否则每 500ms 一次重复写入会拖累 UI。
 */
const lastUIWrite = new Map<string, string>();

let storeUnsubscribe: (() => void) | null = null;
let tickHandle: ReturnType<typeof setInterval> | null = null;

// ────────────────────────────────────────────────────────────────
// 安装 / 卸载
// ────────────────────────────────────────────────────────────────

export function installTaskBridge(): () => void {
  if (storeUnsubscribe) return uninstallTaskBridge;

  // 1) 订阅 store —— 状态机转换 + 上游真实 progress 上报时立刻刷新
  storeUnsubscribe = useTasksStore.subscribe((state) => {
    flushAll(state.tasks);
  });

  // 2) 定时 tick —— 上游不报进度时，UI 也要看到时间外推稳定爬升
  tickHandle = setInterval(() => {
    flushAll(useTasksStore.getState().tasks);
  }, TICK_INTERVAL_MS);

  return uninstallTaskBridge;
}

export function uninstallTaskBridge(): void {
  storeUnsubscribe?.();
  storeUnsubscribe = null;
  if (tickHandle != null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  trackers.clear();
  consumedTerminal.clear();
  lastUIWrite.clear();
}

// ────────────────────────────────────────────────────────────────
// 核心循环
// ────────────────────────────────────────────────────────────────

function flushAll(tasks: ReadonlyMap<string, AsyncTask>): void {
  const ui = useUIStore.getState();
  const seen = new Set<string>();

  for (const task of tasks.values()) {
    seen.add(task.id);
    handleTask(task, ui);
  }

  // tasks 里没有了（被删掉/换项目）的，清理本地状态
  for (const id of trackers.keys()) {
    if (!seen.has(id)) trackers.delete(id);
  }
  for (const id of consumedTerminal) {
    if (!seen.has(id)) consumedTerminal.delete(id);
  }
  for (const id of lastUIWrite.keys()) {
    if (!seen.has(id)) lastUIWrite.delete(id);
  }
}

function handleTask(task: AsyncTask, ui: ReturnType<typeof useUIStore.getState>): void {
  switch (task.status) {
    case "queued":
    case "submitting":
    case "polling": {
      const progress = computeUIProgress(task);
      writeIfChanged(ui, task.id, task.cardId, progress);
      return;
    }
    case "success": {
      if (consumedTerminal.has(task.id)) return;
      consumedTerminal.add(task.id);
      trackers.delete(task.id);
      lastUIWrite.delete(task.id);
      applyResultToCard(task);
      ui.setCardProgress(task.cardId, null);
      ui.setCardError(task.cardId, null);
      return;
    }
    case "failed": {
      if (consumedTerminal.has(task.id)) return;
      consumedTerminal.add(task.id);
      trackers.delete(task.id);
      lastUIWrite.delete(task.id);
      ui.setCardProgress(task.cardId, null);
      ui.setCardError(task.cardId, task.errorMessage ?? "任务失败");
      return;
    }
    case "canceled":
    case "orphaned": {
      if (consumedTerminal.has(task.id)) return;
      consumedTerminal.add(task.id);
      trackers.delete(task.id);
      lastUIWrite.delete(task.id);
      ui.setCardProgress(task.cardId, null);
      // canceled / orphaned 不显示错误（用户主动取消 / 被重试替换）
      return;
    }
  }
}

function writeIfChanged(
  ui: ReturnType<typeof useUIStore.getState>,
  taskId: string,
  cardId: string,
  progress: CardGenProgress,
): void {
  const key = `${progress.percent}|${progress.label}`;
  if (lastUIWrite.get(taskId) === key) return;
  lastUIWrite.set(taskId, key);
  ui.setCardProgress(cardId, progress);
}

// ────────────────────────────────────────────────────────────────
// 进度计算
// ────────────────────────────────────────────────────────────────

function computeUIProgress(task: AsyncTask): CardGenProgress {
  // transient 错误优先：UI 上更应该让用户知道是网络在抖动
  if (task.errorKind && task.errorMessage?.startsWith("[transient]")) {
    return { percent: bumpedPercent(task), label: "网络不稳，重试中…" };
  }

  switch (task.status) {
    case "queued":
      return { percent: 5, label: "已提交，排队中…" };
    case "submitting":
      return { percent: 2, label: "正在提交请求…" };
    case "polling":
      return computePollingProgress(task);
    default:
      // 不应到达这里（terminal 已在 handleTask 处理）
      return { percent: 0, label: "" };
  }
}

function computePollingProgress(task: AsyncTask): CardGenProgress {
  // 上游真报了 >=90 → "正在保存…"，跳过外推
  if (task.progress >= SAVING_THRESHOLD) {
    const tracker = trackers.get(task.id);
    if (tracker) tracker.lastPercent = 92;
    return { percent: 92, label: "正在保存…" };
  }

  const tracker = ensureTracker(task);

  // 真实值（上游报的，capped）和外推值都算出来，取最大值作为展示
  const realCapped = task.progress > 0 ? Math.min(task.progress, CEILING_PERCENT) : 0;
  const elapsedSec = (Date.now() - tracker.startedAtMs) / 1000;
  const range = CEILING_PERCENT - START_PERCENT;
  const fraction = Math.min(1, elapsedSec / tracker.expectedSec);
  const extrapolated = Math.round(START_PERCENT + fraction * range);

  // 单调递增 + 最大值
  const percent = Math.max(realCapped, extrapolated, tracker.lastPercent);
  tracker.lastPercent = percent;

  // 区分"真实"和"预计"：只有当展示数字等于真实进度时才是真实的，
  // 否则是外推/历史 max 留下的，应该标"预计"让用户知道是估算值
  const isEstimated = percent > realCapped;
  const label = isEstimated ? `生成中(预计) ${percent}%` : `生成中 ${percent}%`;

  return { percent, label };
}

/**
 * transient 错误时不让 UI 倒退；保留 tracker 已经爬到的位置，
 * 但用"网络不稳"文案盖掉数字。
 */
function bumpedPercent(task: AsyncTask): number {
  const tracker = trackers.get(task.id);
  if (tracker) return tracker.lastPercent || START_PERCENT;
  return START_PERCENT;
}

function ensureTracker(task: AsyncTask): ProgressTracker {
  let t = trackers.get(task.id);
  if (!t) {
    t = {
      startedAtMs: Date.now(),
      lastPercent: 0,
      expectedSec: inferExpectedSec(task),
    };
    trackers.set(task.id, t);
  }
  return t;
}

// ────────────────────────────────────────────────────────────────
// 结果落卡片
// ────────────────────────────────────────────────────────────────

function applyResultToCard(task: AsyncTask): void {
  const result = task.result;
  if (!result) return;
  const url = typeof result.url === "string" ? result.url : undefined;
  if (!url) return;

  const cardStore = useCardStore.getState();
  const card = cardStore.getCard(task.cardId);
  if (!card) return;

  const patch = buildDataPatch(card, url, result);
  if (!patch) return;

  cardStore.updateCardData(task.cardId, patch);
  autoSave.markDirty(task.cardId);
}

/**
 * 按卡片类型把结果 url 落到对应字段。返回 null 表示该卡片类型不需要落库
 * （例如 sticky_note / text，不参与异步任务）。
 */
function buildDataPatch(
  card: CanvasCard,
  url: string,
  result: Record<string, unknown>,
): Record<string, unknown> | null {
  const data = card.data as Record<string, unknown>;
  const revisedPrompt =
    typeof result.revisedPrompt === "string" ? result.revisedPrompt : undefined;

  switch (card.type) {
    case "ai_image": {
      // 单图：imageUrl + results[0]；编辑器的 await 也会写一遍（同值）
      const existing = (data.results as Array<{ url: string }>) ?? [];
      const next =
        existing.length === 1 && existing[0]?.url === url
          ? existing
          : [{ url, ...(revisedPrompt != null ? { revisedPrompt } : {}) }];
      return {
        imageUrl: url,
        results: next,
        selectedIndex: 0,
        _resultStale: false,
      };
    }
    case "ai_multiangle":
      return { imageUrl: url, _resultStale: false };
    case "ai_tryon":
      return { resultImageUrl: url, _resultStale: false };
    case "ai_video":
      return { videoUrl: url, _resultStale: false };
    case "audio":
      return { audioUrl: url };
    default:
      return null;
  }
}

// 兼容旧代码引用（已不在桥接器内部使用，保留为 export 防止外部依赖打死）
export function labelByTerminalStatus(s: TaskStatus): string {
  if (s === "success") return "完成";
  if (s === "failed") return "失败";
  return "";
}
