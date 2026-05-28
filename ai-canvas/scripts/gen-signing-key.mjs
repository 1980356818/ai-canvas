/**
 * 生成 Tauri updater 签名密钥并把公钥写进 tauri.conf.json。
 *
 * 第一次跑(生成新密钥):
 *   npm run signing:generate
 *   → 会让你输入私钥密码,记下来,release.py 用得到。
 *   → 私钥放在 ~/.tauri/aicat-canvas.key (不进 git)
 *   → 私钥路径写进 .signing-key-path
 *   → tauri.conf.json.plugins.updater.pubkey 自动改成新公钥
 *
 * 后续跑(密钥已存在):
 *   npm run signing:generate
 *   → 仅同步公钥到 tauri.conf.json,密钥不变
 *
 * 打包前(每次新 shell):
 *   PowerShell:
 *     $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "<key path>"
 *     $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<你的密码>"
 *   Bash:
 *     export TAURI_SIGNING_PRIVATE_KEY="$(cat <key path>)"
 *     export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<你的密码>"
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { execSync } from "child_process";
import { homedir } from "os";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriConfPath = resolve(root, "src-tauri", "tauri.conf.json");
const keyPathFile = resolve(root, ".signing-key-path");

// `npm run signing:generate -- --no-password` 走非交互模式(私钥不加密),
// 适合自动化首发。后续想换成带密码的:删 `~/.tauri/aicat-canvas.key{,.pub}`
// 和 `.signing-key-path`,再不带 flag 跑一次。
const NO_PASSWORD = process.argv.slice(2).includes("--no-password");

let keyPath;
if (existsSync(keyPathFile)) {
  keyPath = readFileSync(keyPathFile, "utf-8").trim();
  if (!keyPath) {
    console.error(`[signing] .signing-key-path 为空,删除它后重跑`);
    process.exit(1);
  }
} else {
  keyPath = resolve(homedir(), ".tauri", "aicat-canvas.key");
  mkdirSync(dirname(keyPath), { recursive: true });
}

if (existsSync(keyPath)) {
  console.log(`[signing] reusing existing key at ${keyPath}`);
} else {
  console.log(`[signing] generating new keypair → ${keyPath}`);
  if (NO_PASSWORD) {
    console.log(`[signing] --no-password 模式:私钥不加密(由文件权限保护)\n`);
    // Tauri CLI 不接受 --no-password,但接受 --password "" + --ci(跳过 prompt)
    execSync(
      `npx --yes @tauri-apps/cli signer generate --ci --password "" -w "${keyPath}"`,
      { stdio: "inherit" },
    );
  } else {
    console.log(`[signing] 接下来会提示输入私钥密码,务必记下来,release 时要用。\n`);
    execSync(`npx --yes @tauri-apps/cli signer generate -w "${keyPath}"`, {
      stdio: "inherit",
    });
  }
  writeFileSync(keyPathFile, keyPath + "\n");
  console.log(`\n[signing] key path written to ${keyPathFile}`);
}

const pubPath = keyPath + ".pub";
if (!existsSync(pubPath)) {
  console.error(`[signing] public key file missing: ${pubPath}`);
  process.exit(1);
}

const pubkey = readFileSync(pubPath, "utf-8").trim();
const tauriConf = JSON.parse(readFileSync(tauriConfPath, "utf-8"));
tauriConf.plugins ??= {};
tauriConf.plugins.updater ??= {};
const oldPubkey = tauriConf.plugins.updater.pubkey;
tauriConf.plugins.updater.pubkey = pubkey;
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n");

if (oldPubkey === pubkey) {
  console.log(`[signing] tauri.conf.json already up to date`);
} else {
  console.log(`[signing] tauri.conf.json updater.pubkey updated`);
}

console.log(`\n========================================================`);
console.log(`下一步:打包前在 shell 里导出环境变量:`);
console.log(``);
if (NO_PASSWORD) {
  console.log(`  PowerShell:`);
  console.log(`    $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "${keyPath}"`);
  console.log(`    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""`);
  console.log(``);
  console.log(`  macOS / Linux:`);
  console.log(`    export TAURI_SIGNING_PRIVATE_KEY="$(cat ${keyPath})"`);
  console.log(`    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""`);
} else {
  console.log(`  PowerShell:`);
  console.log(`    $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "${keyPath}"`);
  console.log(`    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<你的密码>"`);
  console.log(``);
  console.log(`  macOS / Linux:`);
  console.log(`    export TAURI_SIGNING_PRIVATE_KEY="$(cat ${keyPath})"`);
  console.log(`    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<你的密码>"`);
}
console.log(``);
console.log(`release.py 会自动读取这两个变量。`);
console.log(`========================================================`);
