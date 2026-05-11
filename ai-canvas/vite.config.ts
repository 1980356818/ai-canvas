import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import pkg from "./package.json" with { type: "json" };

const host = process.env.TAURI_DEV_HOST;

const COMFLY_API = "https://ai.comfly.chat";
const JIJING_API = "https://ai.snoworangekeji.cn";

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
  plugins: [react(), tailwindcss()],
  css: {
    transformer: "lightningcss",
    lightningcss: {
      // Chrome 99 supports @layer (required by Tailwind v4);
      // setting this target makes LightningCSS convert oklch() → rgb()
      // so the app renders correctly on older WebView2 runtimes.
      targets: { chrome: 99 << 16 },
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
        ? "chrome105"
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
