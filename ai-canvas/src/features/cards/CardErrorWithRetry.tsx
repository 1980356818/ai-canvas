/**
 * 卡片级错误显示 + 重试按钮。
 *
 * 行为：
 *   - 永远显示错误文案
 *   - 若该 card 最近一次任务状态是 failed / canceled，附加"重试"按钮
 *   - 点击重试 → `taskManager.retry(taskId)`：把旧任务标 orphaned，用同样的请求
 *     起一个新 task，UI 会立即接到新任务的 active 状态并恢复进度条
 *
 * 两种排版：
 *   - panel  整张占位（卡片内尚无结果可显示时）
 *   - ribbon 底部条带（卡片有图/视频但叠加错误）
 */

import { useCallback, type MouseEvent, type PointerEvent } from "react";
import { AlertCircle, RotateCw } from "lucide-react";
import { useTasksStore, selectLatestTaskForCard } from "@/stores/tasksStore";
import { useUIStore } from "@/stores/uiStore";
import { taskManager } from "@/services/taskManager";

export type CardErrorVariant = "panel" | "ribbon";

interface Props {
  cardId: string;
  message: string;
  variant?: CardErrorVariant;
}

export function CardErrorWithRetry({ cardId, message, variant = "panel" }: Props) {
  const latestTask = useTasksStore(selectLatestTaskForCard(cardId));
  const canRetry =
    latestTask?.status === "failed" || latestTask?.status === "canceled";

  const handleRetry = useCallback(
    async (e: MouseEvent) => {
      e.stopPropagation();
      if (!latestTask) return;
      try {
        // 清掉旧的 uiStore 错误提示；新任务一启动 active 状态就会接管 UI
        useUIStore.getState().setCardError(cardId, null);
        await taskManager.retry(latestTask.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        useUIStore.getState().setCardError(cardId, msg);
      }
    },
    [cardId, latestTask],
  );

  const stopDrag = useCallback((e: PointerEvent) => {
    e.stopPropagation();
  }, []);

  if (variant === "ribbon") {
    return (
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-destructive/90 px-2 py-1">
        <p className="flex-1 truncate text-[10px] text-white">{message}</p>
        {canRetry && (
          <button
            type="button"
            onPointerDown={stopDrag}
            onClick={handleRetry}
            className="shrink-0 rounded bg-white/20 px-1.5 py-0.5 text-[10px] font-medium text-white transition-colors hover:bg-white/30"
          >
            重试
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
      <AlertCircle className="h-8 w-8 text-destructive/60" />
      <p className="line-clamp-3 text-xs leading-relaxed text-destructive/80">
        {message}
      </p>
      {canRetry ? (
        <button
          type="button"
          onPointerDown={stopDrag}
          onClick={handleRetry}
          className="mt-1 inline-flex items-center gap-1 rounded-md bg-primary/10 px-3 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20"
        >
          <RotateCw className="h-3 w-3" />
          重试
        </button>
      ) : (
        <span className="text-[10px] text-muted-foreground">点击卡片查看详情</span>
      )}
    </div>
  );
}
