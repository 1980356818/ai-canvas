/**
 * Task → UI 桥接器（**polling 阶段唯一的 UI 进度产出源**）。
 *
 * 把 tasksStore 的状态机变化映射到 UI 层的两个地方：
 *   1. uiStore.generatingCards / cardErrors  ——  进度条 / 错误 UI
 *   2. cardStore card.data.{imageUrl|videoUrl|...}  ——  成功结果落到对应字段
 *
 * ## 进度数字 = task.progress
 *
 * 直接透传上游真实进度，和任务记录页 (`TaskRecordCard`) 保持一致。
 * 早期版本做过"时间外推 + 单调 max"让数字一直爬，结果用户看到的百分比
 * 和任务记录里的对不上（卡片 50%、任务记录 30%）——视觉上"乱"。删了。
 * 副作用：上游不报进度时（task.progress 一直 0），卡片底部进度条会卡 0% +
 * shimmer 动画，跟任务记录此时的空进度条语义一致。
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
import { scheduleCardMediaLocalization } from "@/lib/mediaLocalize";
import {
  beginGeneration,
  confirmGeneration,
  failGeneration,
} from "@/services/generation/runProvenance";
import type { AsyncTask, CanvasCard, TaskStatus } from "@/types";
import type { CardGenProgress } from "@/types/ui";

// ────────────────────────────────────────────────────────────────
// 内部状态
// ────────────────────────────────────────────────────────────────

/** 终态消费过的任务 id（避免重复写 card.data）。 */
const consumedTerminal = new Set<string>();
/**
 * 已盖过 begin 溯源戳的任务 id（每个任务只在首次非终态出现时盖一次 pending 戳）。
 * 媒体任务(图/视频/试衣/多角度)的溯源 begin/confirm/fail 统一收敛在本桥接器 —— 它是
 * 编辑器手点 / 组运行 / 崩溃恢复 resumed 任务**唯一**都经过的路径(见文件头注释)。
 */
const provenancedTasks = new Set<string>();
/** 上次写到 UI 的 (percent, label) 组合，用于订阅去重避免无意义 setCardProgress。 */
const lastUIWrite = new Map<string, string>();

let storeUnsubscribe: (() => void) | null = null;

// ────────────────────────────────────────────────────────────────
// 安装 / 卸载
// ────────────────────────────────────────────────────────────────

export function installTaskBridge(): () => void {
  if (storeUnsubscribe) return uninstallTaskBridge;

  // 订阅 store —— 状态机转换 + 上游真实 progress 上报时立刻刷新
  storeUnsubscribe = useTasksStore.subscribe((state) => {
    flushAll(state.tasks);
  });

  return uninstallTaskBridge;
}

export function uninstallTaskBridge(): void {
  storeUnsubscribe?.();
  storeUnsubscribe = null;
  consumedTerminal.clear();
  lastUIWrite.clear();
  provenancedTasks.clear();
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
  for (const id of consumedTerminal) {
    if (!seen.has(id)) consumedTerminal.delete(id);
  }
  for (const id of lastUIWrite.keys()) {
    if (!seen.has(id)) lastUIWrite.delete(id);
  }
  for (const id of provenancedTasks) {
    if (!seen.has(id)) provenancedTasks.delete(id);
  }
}

function handleTask(task: AsyncTask, ui: ReturnType<typeof useUIStore.getState>): void {
  switch (task.status) {
    case "queued":
    case "submitting":
    case "polling": {
      // 首次非终态出现 → 盖 pending 溯源戳(捕获提交时的输入指纹)。捕获在任务入队这一刻,
      // 此时 card.data 还是提交态(build*Request 已归一好 model);crash 后 resumed 任务
      // 首次以 polling 出现也会补盖,fp 与提交时一致(data 已持久化)。
      if (!provenancedTasks.has(task.id)) {
        provenancedTasks.add(task.id);
        beginGeneration(task.cardId);
      }
      const progress = computeUIProgress(task);
      writeIfChanged(ui, task.id, task.cardId, progress);
      return;
    }
    case "success": {
      if (consumedTerminal.has(task.id)) return;
      consumedTerminal.add(task.id);
      lastUIWrite.delete(task.id);
      applyResultToCard(task);
      // 结果已落卡 → 确认溯源戳(pending→false,fp 不重算)。断点续跑据此跳过本卡。
      confirmGeneration(task.cardId);
      ui.setCardProgress(task.cardId, null);
      ui.setCardError(task.cardId, null);
      return;
    }
    case "failed": {
      if (consumedTerminal.has(task.id)) return;
      consumedTerminal.add(task.id);
      lastUIWrite.delete(task.id);
      // 失败 → 清溯源戳(回到「无戳」→ 断点续跑必重跑本卡)。
      failGeneration(task.cardId);
      ui.setCardProgress(task.cardId, null);
      ui.setCardError(task.cardId, task.errorMessage ?? "任务失败");
      return;
    }
    case "canceled":
    case "orphaned": {
      if (consumedTerminal.has(task.id)) return;
      consumedTerminal.add(task.id);
      lastUIWrite.delete(task.id);
      // 取消(强制中止)/ 被重试替换 → 清溯源戳(无确认结果,断点续跑应重跑)。
      failGeneration(task.cardId);
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
  // 数字一律取 task.progress 的整数化，跟任务记录页保持一致。
  const percent = Math.round(Math.max(0, Math.min(100, task.progress)));

  // transient 错误优先：UI 上更应该让用户知道是网络在抖动
  if (task.errorKind && task.errorMessage?.startsWith("[transient]")) {
    return { percent, label: "网络不稳，重试中…" };
  }

  switch (task.status) {
    case "queued":
      return { percent, label: "已提交，排队中…" };
    case "submitting":
      return { percent, label: "正在提交请求…" };
    case "polling":
      return { percent, label: `生成中 ${percent}%` };
    default:
      // 不应到达这里（terminal 已在 handleTask 处理）
      return { percent: 0, label: "" };
  }
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

  // finalize(saveMedia)失败时 url 仍是远端 http(s) —— 远端地址不可靠(时效签名 /
  // 境外站国内不可达),交给统一收敛模块退避补救。本地路径时这里是 no-op。
  scheduleCardMediaLocalization(task.cardId);
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
