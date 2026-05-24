import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "src-tauri"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2021,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // ─── v5 性能规范兜底（见 docs/性能与IPC规范.md）────────────────
      // 自定义 selector 用 ESLint 内置 no-restricted-syntax 实现，无需第三方
      // 插件。每条 message 解释"为什么禁 + 改成什么"。
      "no-restricted-syntax": [
        "error",
        {
          // 禁止 `useCardStore((s) => s.cards)` —— cards Map 每次 mutation
          // 都换引用，订阅它等于"任何写都重渲"。改订 layoutVersion / dataVersion，
          // effect 内 imperative 取 `useCardStore.getState().cards`。
          selector:
            "CallExpression[callee.name='useCardStore'] > ArrowFunctionExpression > MemberExpression[property.name='cards']",
          message:
            "禁止订阅整个 cards Map（v5 规范）。改订 useCardStore((s) => s.layoutVersion) 或 s.dataVersion；effect/useMemo 内用 useCardStore.getState().cards 取最新快照。",
        },
        {
          // 禁止 `useConnectionStore((s) => s.connections)` 作 useMemo deps
          // 来源 —— connections Map 每次 add/remove 都换引用。改订
          // connectionsVersion 数字。
          selector:
            "CallExpression[callee.name='useConnectionStore'] > ArrowFunctionExpression > MemberExpression[property.name='connections']",
          message:
            "禁止订阅整个 connections Map（v5 规范）。改订 useConnectionStore((s) => s.connectionsVersion)；effect/useMemo 内用 useConnectionStore.getState().connections 取最新快照。ConnectionLayer 主 render 列表的特殊情况可加 eslint-disable-next-line 并说明理由。",
        },
        {
          // 禁止直接 `invoke("save_*_batch", ...)` —— 单次 payload 可能爆
          // 3MB IPC 上限。必须经 invokeBatched 分批（src/lib/ipcBatch.ts）。
          selector:
            "CallExpression[callee.name='invoke'][arguments.0.type='Literal'][arguments.0.value=/^save_.+_batch$/]",
          message:
            "禁止直接 invoke save_*_batch（v5 规范）。必须经 @/lib/ipcBatch 的 invokeBatched 分批传递，否则可能超 IPC_PAYLOAD_HARD_LIMIT 3MB 导致 WebView2 渲染进程崩溃。",
        },
        {
          // 禁止 `JSON.stringify(a) === JSON.stringify(b)` deep-equal 反模式
          // —— 对含 base64 / 长 prompt 的对象是 O(2N) + 字符串比较。
          selector:
            "BinaryExpression[operator='==='][left.type='CallExpression'][left.callee.object.name='JSON'][left.callee.property.name='stringify'][right.type='CallExpression'][right.callee.object.name='JSON'][right.callee.property.name='stringify']",
          message:
            "禁止 JSON.stringify(a) === JSON.stringify(b) 做 deep-equal（v5 规范）。改用 shallow-key-equal 或版本号信号比对。",
        },
        {
          // 禁止直接调 getBase64ForApi —— Tauri 下返 local:// 占位符再走 base64
          // inline,会撞 IPC 64MB / nginx 100MB / MySQL request_params。必须用
          // mediaToApiRef (来自 @/platform/media),先 /v1/files/upload 拿 HTTP URL
          // 再塞 JSON。详见 docs/media-upload-refactor.md。
          selector:
            "CallExpression[callee.name='getBase64ForApi']",
          message:
            "禁止 getBase64ForApi —— 用 mediaToApiRef (@/platform/media) 替代。getBase64ForApi 走 local:// → Rust inline base64 路径,撞 IPC 64MB / nginx 100MB / MySQL request_params 上限。详见 docs/media-upload-refactor.md。",
        },
      ],
    },
  },
);
