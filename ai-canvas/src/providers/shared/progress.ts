import type { GenerationProgress } from "../types";

/**
 * 进度平滑器: 优先采用上游真实 progress, 若上游不报 (进 generating 状态后 progress=0
 * 持续上报), 用时间外推从 5% 走到 ~90%, 等真实 success 再跳到 100%。
 *
 * 解决"卡 10% 突然完成"的体验问题:
 *   - 之前 emit `Math.min(progress, 90) || 10` → progress=0 时永远 10
 *   - 现在按 elapsed/expectedSec 推算, 默认 25s (image), Veo 用 120s, Seedance 90s
 *
 * 用法:
 *   const onProgress = makeSmoothProgressTracker(emit, { expectedSec: 25 });
 *   await waitForTask(taskId, onProgress, ...);
 */

export interface SmoothProgressOptions {
  /** 预期任务时长(秒), 用于时间外推。image 一般 25s, video 60~120s。 */
  expectedSec?: number;
  /** generating 阶段起步百分比, 默认 10。 */
  startPercent?: number;
  /** generating 阶段顶部百分比 (达到后停止外推), 默认 90。 */
  ceilingPercent?: number;
  /** 文案: 排队中 / 生成中。 */
  queuedLabel?: string;
  generatingLabel?: string;
}

export type ProgressCallback = (progress: number, status: string) => void;

export function makeSmoothProgressTracker(
  emit: ((p: GenerationProgress) => void) | undefined,
  options: SmoothProgressOptions = {},
): ProgressCallback {
  const {
    expectedSec = 25,
    startPercent = 10,
    ceilingPercent = 90,
    queuedLabel = "排队中…",
    generatingLabel = "生成中…",
  } = options;

  let lastEmittedPercent = 0;
  let generatingStartedAt: number | null = null;

  return (progress: number, status: string) => {
    if (!emit) return;
    const st = status.toLowerCase();

    if (st === "queued" || st === "pending" || st === "submitted") {
      const percent = Math.max(5, progress);
      if (percent !== lastEmittedPercent) {
        emit({ percent, phase: "queued", label: queuedLabel });
        lastEmittedPercent = percent;
      }
      return;
    }

    // 标记 generating 阶段起始时刻 (从 queued 跳过来时重置基线)
    if (generatingStartedAt == null) {
      generatingStartedAt = Date.now();
    }

    let percent: number;
    if (progress > 0 && progress >= lastEmittedPercent) {
      // 上游报了真实进度, 直接用 (capped to ceiling)
      percent = Math.min(progress, ceilingPercent);
    } else {
      // 上游不报 / 报 0 / 倒退: 用时间外推
      const elapsedSec = (Date.now() - generatingStartedAt) / 1000;
      const range = ceilingPercent - startPercent;
      const fraction = Math.min(1, elapsedSec / expectedSec);
      percent = Math.round(startPercent + fraction * range);
    }

    // 单调递增 (避免抖动)
    percent = Math.max(percent, lastEmittedPercent);
    if (percent !== lastEmittedPercent) {
      emit({ percent, phase: "generating", label: generatingLabel });
      lastEmittedPercent = percent;
    }
  };
}

// 各类任务的经验时长 (上游不报 progress 时用作时间外推的分母)
export const PROGRESS_EXPECTED_SEC = {
  image: 25,      // gpt-image-2 ~16s, nano-banana ~10s
  imageHD: 40,    // 2K/4K 大一点
  videoVeo: 120,  // Veo 3.1 fast ~90s, pro 更久
  videoSeedance: 90,
  videoGeneric: 90,
} as const;
