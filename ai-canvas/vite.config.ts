import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import pkg from "./package.json" with { type: "json" };

const host = process.env.TAURI_DEV_HOST;

// ── 2026-05-30 根治: 删除 vite proxy ─────────────────────────────────────
//
// 历史:vite.config.ts 这里曾经声明 /v1-proxy / /v1-jijing / /v1-jijing-global
// 三个 dev-only proxy 前缀,给浏览器 dev 模式直接 fetch 上游用 (绕 CORS)。
//
// 现在:ai-canvas 是 Tauri 桌面应用, 前端**不允许**直接 fetch 上游,所有上行
// 请求一律走 Rust invoke (`platform/httpAdapter.ts` → `ai_proxy` /
// `http_request` / `upload_bytes_to_server`)。vite proxy 已无用户, 删除后:
//   - 前端代码物理上不可能"在 dev 模式凑巧能跑、prod 挂"的双语义 bug
//   - vite.config.ts 不再有上游域名硬编码, 改 base url 不再需要同步两边
//
// 详见 src/platform/httpAdapter.ts 顶部注释 + CLAUDE.md "前端上行 HTTP 规范"。

/**
 * Strip CSS `@layer` wrappers from production output so the app renders
 * correctly on WebView2 runtimes older than Chrome 99 (which silently
 * discard all rules inside unsupported `@layer` blocks).
 * The inner rules are kept as-is; only the `@layer name { }` envelope is
 * removed.  Source order already guarantees the correct cascade for
 * Tailwind v4 (base → components → utilities).
 */
function cssUnwrapLayers(): Plugin {
  return {
    name: "css-unwrap-layers",
    enforce: "post",
    generateBundle(_opts, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === "asset" && typeof file.source === "string" && file.fileName.endsWith(".css")) {
          file.source = unwrapLayers(file.source);
        }
      }
    },
  };
}

function unwrapLayers(css: string): string {
  // Remove `@layer <name> { … }` wrappers while keeping the inner content.
  // Handles nested braces by counting depth.
  let result = "";
  let i = 0;
  while (i < css.length) {
    const layerMatch = css.slice(i).match(/^@layer\s+[\w\-.,\s]*\{/);
    if (layerMatch) {
      i += layerMatch[0].length;
      let depth = 1;
      const start = i;
      while (i < css.length && depth > 0) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}") depth--;
        if (depth > 0) i++;
      }
      result += css.slice(start, i);
      i++; // skip closing brace
      continue;
    }
    // Also strip bare `@layer <names>;` order declarations
    const orderMatch = css.slice(i).match(/^@layer\s+[\w\-.,\s]+;/);
    if (orderMatch) {
      i += orderMatch[0].length;
      continue;
    }
    result += css[i];
    i++;
  }
  return result;
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react(), tailwindcss(), cssUnwrapLayers()],
  css: {
    transformer: "lightningcss",
    lightningcss: {
      // Target Chrome 80 so LightningCSS down-converts modern CSS features
      // (oklch → rgb, color-mix, :is(), etc.) for older WebView2 runtimes.
      // `@layer` is separately handled by the cssUnwrapLayers plugin.
      targets: { chrome: 80 << 16 },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === "windows"
        ? "chrome90"
        : "safari15",
    emptyOutDir: true,
  },
  clearScreen: false,
  server: {
    port: 1620,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host ? { protocol: "ws", host, port: 1621 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    // 已删除 proxy 配置 —— 前端不直连上游, 见本文件顶部注释。
  },
});
