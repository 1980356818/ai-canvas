#!/usr/bin/env node
/**
 * 跨平台 dispatcher —— 把 npm run check:ipc-guards 路由到对应的 shell 脚本。
 *
 * Windows: scripts/check-ipc-guards.ps1
 * macOS / Linux: scripts/check-ipc-guards.sh
 *
 * 为啥不直接在 npm script 写两行:
 *   - 当前 `prebuild` / Tauri `beforeBuildCommand` 配的是单一 `npm run check:ipc-guards`,
 *     在 GitHub Actions 同时跑 build-windows + build-macos 两条 runner 上,
 *     如果两端不同命令,只能加 `if (RUNNER_OS == 'Windows')` 的 YAML 分支,可读性差。
 *   - 此处 Node script 统一入口,平台检测在一个地方做,任意环境(本地 dev / CI)行为一致。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const isWindows = process.platform === "win32";
const script = isWindows
  ? resolve(__dirname, "check-ipc-guards.ps1")
  : resolve(__dirname, "check-ipc-guards.sh");

if (!existsSync(script)) {
  console.error(`[check-ipc-guards] FATAL: 找不到脚本 ${script}`);
  process.exit(2);
}

const [cmd, args] = isWindows
  ? ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]]
  : ["bash", [script]];

const result = spawnSync(cmd, args, { stdio: "inherit" });
if (result.error) {
  console.error(`[check-ipc-guards] FATAL: 启动 ${cmd} 失败: ${result.error.message}`);
  process.exit(2);
}
process.exit(result.status ?? 1);
