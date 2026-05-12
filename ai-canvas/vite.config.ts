import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import pkg from "./package.json" with { type: "json" };

const host = process.env.TAURI_DEV_HOST;

const COMFLY_API = "https://ai.comfly.chat";
const JIJING_API = "https://ai.snoworangekeji.cn";

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

function proxyConfig(target: string, prefix: string) {
  return {
    target,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(new RegExp(`^${prefix}`), ""),
    secure: false,
    configure(proxy: { on: (event: string, handler: (...args: never[]) => void) => void }) {
      proxy.on("proxyReq", (proxyReq: { removeHeader: (name: string) => void }) => {
        proxyReq.removeHeader("origin");
        proxyReq.removeHeader("referer");
      });
    },
  };
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
    proxy: {
      "/v1-proxy": proxyConfig(COMFLY_API, "\\/v1-proxy"),
      "/v1-jijing": proxyConfig(JIJING_API, "\\/v1-jijing"),
    },
  },
});
