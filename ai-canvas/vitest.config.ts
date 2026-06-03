import { defineConfig } from "vitest/config";
import path from "path";

// 独立于 vite.config.ts:测试不需要 react/tailwind/lightningcss 插件,只要 @ 别名 +
// __APP_VERSION__ 占位(部分模块在 import 期引用)。环境用 node —— build*Request 对
// 无素材/http 素材卡是纯函数,不依赖 DOM。
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify("test"),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
