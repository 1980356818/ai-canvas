import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

const COMFLY_API = "https://ai.comfly.chat";
const JIJING_API = "https://ai.snoworangekeji.cn";

function proxyConfig(target: string, prefix: string) {
  return {
    target,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(new RegExp(`^${prefix}`), ""),
    secure: false,
    configure(proxy: import("http-proxy").Server) {
      proxy.on("proxyReq", (proxyReq) => {
        proxyReq.removeHeader("origin");
        proxyReq.removeHeader("referer");
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
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
