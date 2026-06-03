/**
 * Dev-only 日志门面 —— **本仓所有 dev 日志的统一入口**。
 *
 * ─── 为什么要有这一层 ───────────────────────────────────────────
 * 历史上 MediaEditor / dataFlow / ai.api / chatStore 等各自写
 * `const DEBUG = import.meta.env.DEV` + 散落的 `if (DEBUG) console.log`,
 * 或者更糟 —— 直接裸 `console.log("[Module] ...", bigObject)`。
 *
 * 两个真实代价:
 *   1) **点击瞬间卡**: Tauri WebView2 里 DevTools 打开后,
 *      `console.log(largeObject)` / `console.group` 是同步序列化,
 *      handleGenerate 入口塞 10+ 处就能冻 100~300ms。用户感受 = "点击就卡"。
 *   2) **prod 噪声**: 没守门的 console.log 在生产构建里仍然执行,
 *      不仅泄漏内部结构,也持有大对象阻碍 GC。
 *
 * ─── 用法规范 ──────────────────────────────────────────────────
 *   const log = createLogger("MediaEditor");
 *   log.group("handleGenerate 开始");
 *   log.log("卡片数据", { ... });
 *   log.groupEnd();
 *
 * 语义:
 *   • `.log` / `.group` / `.groupEnd` 只在 DEV 下输出;prod 是 noop,
 *     `import.meta.env.DEV` 是 vite 编译期常量, esbuild minify 时
 *     `if (false)` 整支会被删,运行时零开销。
 *   • `.warn` / `.error` 在 prod 也保留 —— 真异常的兜底,需要让用户/
 *     上报通道看到,不能被静默。统一前缀方便 grep。
 *
 * ─── 不该用 ────────────────────────────────────────────────────
 *   • 日志里 dump 整张图的 base64 / 大对象的完整 ref —— 即便 DEV,
 *     DevTools 序列化的代价依然在主线程。要么 `slice(60)`,要么别打。
 *   • 把 `log.log` 当成"流程注释"刷屏 —— 真要追流程,断点更准,
 *     Performance flamegraph 更全。
 */

export const DEBUG = import.meta.env.DEV;

export interface DebugLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  group: (label: string) => void;
  groupEnd: () => void;
}

const noop = () => {};

export function createLogger(namespace: string): DebugLogger {
  const prefix = `[${namespace}]`;
  if (!DEBUG) {
    return {
      log: noop,
      warn: (...args) => console.warn(prefix, ...args),
      error: (...args) => console.error(prefix, ...args),
      group: noop,
      groupEnd: noop,
    };
  }
  return {
    log: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
    group: (label: string) => console.group(`${prefix} ${label}`),
    groupEnd: () => console.groupEnd(),
  };
}
