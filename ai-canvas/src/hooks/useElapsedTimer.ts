import { useEffect, useState } from "react";

/**
 * 共享的"每秒一次"全局 tick，给所有需要显示 elapsed 时间的组件复用。
 *
 * 设计动机（v5）：
 *   过去每个聊天气泡 / 卡片 loading / 媒体卡都各自起一个 `setInterval(1000)`，
 *   一个长会话里几十个气泡同时跑 → 几十个 timer + 几十次 setState/帧渲染。
 *   现在所有调用方共享同一个 timer，timer 只在至少有一个 listener 时存在，
 *   全部 unmount 后自动 clearInterval。
 *
 * 用法：
 *   const elapsedMs = useElapsedTimer(startedAt);  // startedAt: epoch ms，
 *                                                  // null/0 表示不计时
 *
 * 实现要点：
 * - 模块级 listener Set，一次注册一次解注册，无 race。
 * - tick 时遍历 listeners，每个 listener 自己决定 setState 与否（每秒最多一次）。
 * - 没有 listener 时干掉 interval，避免长时间挂机时空跑。
 */

type Listener = (now: number) => void;
const listeners = new Set<Listener>();
let intervalHandle: ReturnType<typeof setInterval> | null = null;

function ensureTick() {
  if (intervalHandle !== null) return;
  intervalHandle = setInterval(() => {
    const now = Date.now();
    // 复制一遍，listener 内 unmount 不影响本轮迭代
    for (const fn of Array.from(listeners)) {
      fn(now);
    }
  }, 1000);
}

function stopTickIfIdle() {
  if (listeners.size === 0 && intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/**
 * 返回 `Date.now() - startedAt` 的实时值。startedAt 为 null / 0 / 负数时返回 0。
 * 每秒最多更新一次（与全局 tick 对齐）。
 */
export function useElapsedTimer(startedAt: number | null | undefined): number {
  const valid = typeof startedAt === "number" && startedAt > 0;
  const [elapsed, setElapsed] = useState(() => (valid ? Date.now() - startedAt : 0));

  useEffect(() => {
    if (!valid) {
      setElapsed(0);
      return;
    }
    // 第一次同步设置一次，避免等到下一个 tick 才显示
    setElapsed(Date.now() - startedAt);

    const listener: Listener = (now) => {
      setElapsed(now - startedAt);
    };
    listeners.add(listener);
    ensureTick();

    return () => {
      listeners.delete(listener);
      stopTickIfIdle();
    };
  }, [valid, startedAt]);

  return elapsed;
}
