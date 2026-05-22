/**
 * 全局诊断/日志/崩溃兜底。
 *
 * 设计目标：
 *   1. WebView 渲染进程级别的崩溃 (OOM / GPU 死) 前能留下尽可能多的线索。
 *   2. unhandledrejection / window.error / ErrorBoundary 走同一条记录路径，
 *      落到 Rust 端 tracing → app.log.YYYY-MM-DD，下次启动还能查。
 *   3. 同样的错在短时间内只 toast 一次，避免刷屏。
 *
 * 不做的事：自动恢复 / 重试。诊断模块只观察，副作用最小。
 */

import { isTauri, ensureTauriAPIs, getInvoke } from "@/platform/runtime";

export type DiagLevel = "error" | "warn" | "info" | "debug";

export interface DiagPayload {
  level: DiagLevel;
  source: string;
  message: string;
  stack?: string;
  url?: string;
  line?: number;
  column?: number;
  extra?: unknown;
}

interface DedupKey {
  source: string;
  message: string;
}

const TOAST_DEDUP_MS = 5_000;
const _recentToasts = new Map<string, number>();

function dedupKey(p: DedupKey): string {
  return `${p.source}::${p.message}`;
}

function shouldToast(p: DedupKey): boolean {
  const key = dedupKey(p);
  const now = Date.now();
  const last = _recentToasts.get(key) ?? 0;
  if (now - last < TOAST_DEDUP_MS) return false;
  _recentToasts.set(key, now);
  // 顺手清掉过期项，避免 Map 无限增长
  for (const [k, t] of _recentToasts) {
    if (now - t > TOAST_DEDUP_MS * 4) _recentToasts.delete(k);
  }
  return true;
}

async function forwardToTauri(p: DiagPayload): Promise<void> {
  if (!isTauri) return;
  try {
    await ensureTauriAPIs();
    await getInvoke()("js_log", { payload: p });
  } catch {
    /* 不能让 diag 自己抛错，否则递归 */
  }
}

async function surfaceToast(p: DiagPayload): Promise<void> {
  if (p.level !== "error") return;
  if (!shouldToast(p)) return;
  try {
    const { useUIStore } = await import("@/stores/uiStore");
    useUIStore.getState().addToast({
      type: "error",
      title: "出现异常",
      description: `[${p.source}] ${p.message.slice(0, 200)}`,
      duration: 6000,
    });
  } catch {
    /* uiStore 没初始化（极早期崩溃），算了 */
  }
}

/** 唯一对外 API：记录一条诊断信息。失败永不抛错。 */
export function diagLog(p: DiagPayload): void {
  const consoleFn =
    p.level === "error" ? console.error : p.level === "warn" ? console.warn : console.log;
  consoleFn(`[diag:${p.source}]`, p.message, p.extra ?? "");

  void forwardToTauri(p);
  void surfaceToast(p);
}

/** error 简写：参数兼容 unknown，自动序列化。 */
export function diagError(source: string, err: unknown, extra?: unknown): void {
  const e = err as Error | undefined;
  diagLog({
    level: "error",
    source,
    message: e?.message ?? String(err),
    stack: e?.stack,
    extra,
  });
}

export function diagWarn(source: string, message: string, extra?: unknown): void {
  diagLog({ level: "warn", source, message, extra });
}

export function diagInfo(source: string, message: string, extra?: unknown): void {
  diagLog({ level: "info", source, message, extra });
}

/**
 * 安装全局 unhandledrejection / error 监听 + 内存压力检测 + 长任务监听。
 * 在 main.tsx 启动时调一次。重复调用是 no-op。
 */
let _installed = false;
export function installGlobalDiag(): void {
  if (_installed) return;
  _installed = true;

  // ── 1. 全局未捕获 Promise 异常 ──
  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const err = reason instanceof Error ? reason : new Error(String(reason));
    diagLog({
      level: "error",
      source: "unhandledrejection",
      message: err.message,
      stack: err.stack,
    });
  });

  // ── 2. 全局同步异常（含 React 渲染外的 setTimeout / 事件回调） ──
  window.addEventListener("error", (event: ErrorEvent) => {
    // 跨域脚本错误浏览器只给 "Script error." 无栈，跳过没意义的记录
    if (!event.message || event.message === "Script error.") return;
    diagLog({
      level: "error",
      source: "window.error",
      message: event.message,
      stack: event.error?.stack,
      url: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  });

  // ── 3. 长任务监听：>200ms 的主线程阻塞 ──
  // WebView2 在长任务下会标记渲染进程为"无响应"，是白屏崩溃的常见前兆。
  if (typeof PerformanceObserver !== "undefined") {
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < 200) continue;
          diagLog({
            level: "warn",
            source: "long-task",
            message: `${entry.name} blocked main thread ${Math.round(entry.duration)}ms`,
            extra: { startTime: entry.startTime, duration: entry.duration },
          });
        }
      });
      obs.observe({ entryTypes: ["longtask"] });
    } catch {
      /* 部分 WebView 不支持 longtask，无所谓 */
    }
  }

  // ── 4. JS Heap 监控（仅 Chromium / WebView2 有 performance.memory）──
  // 每 30 秒采样，超过阈值或快速增长时报警。
  const perfMem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } })
    .memory;
  if (perfMem) {
    let lastUsed = perfMem.usedJSHeapSize;
    setInterval(() => {
      const used = perfMem.usedJSHeapSize;
      const limit = perfMem.jsHeapSizeLimit;
      const ratio = used / limit;
      // 超过 80% 直接报警（WebView2 渲染进程 OOM 阈值大概在这附近）
      if (ratio > 0.8) {
        diagLog({
          level: "warn",
          source: "heap-pressure",
          message: `JS heap ${Math.round(ratio * 100)}% used (${Math.round(used / 1_048_576)}MB / ${Math.round(limit / 1_048_576)}MB)`,
          extra: { usedMB: used / 1_048_576, limitMB: limit / 1_048_576 },
        });
      }
      // 10 秒内增长 > 50MB（≈ 一次大图解码）也记一笔
      if (used - lastUsed > 50 * 1_048_576) {
        diagLog({
          level: "info",
          source: "heap-growth",
          message: `JS heap +${Math.round((used - lastUsed) / 1_048_576)}MB since last tick`,
          extra: { deltaMB: (used - lastUsed) / 1_048_576, usedMB: used / 1_048_576 },
        });
      }
      lastUsed = used;
    }, 30_000);
  }

  diagInfo("diag", "global diagnostics installed");
}
