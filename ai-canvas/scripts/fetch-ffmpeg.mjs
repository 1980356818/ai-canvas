#!/usr/bin/env node
/**
 * 拉一份 ffmpeg.exe 放到 `src-tauri/binaries/ffmpeg-<triple>[.exe]`,
 * 让 Tauri externalBin 在打包 / dev 时把它一起带进 target 目录。
 *
 * 为什么不进 git:这个 zip 解出来 ~100MB,塞 git 历史每次 clone 翻倍。
 * 改成本地脚本拉,只在首次 / 升级时跑一次,通过 `package.json` 钩到
 * `pretauri`(也就是任何走 `npm run tauri ...` 之前),避免新机器漏拉。
 *
 * 不强制 SHA 锁版:gyan 的 release 端点 (`.../ffmpeg-release-essentials.zip`)
 * 自带 302 跳到最新 tagged 版本,这里靠 `--version=x.y.z` 锁版 (可选)。
 * 不传就用 `.ffmpeg-version` 里的版本号(若存在),否则用 hard-coded fallback。
 *
 * 平台支持:
 *   - Windows x64 → gyan.dev ffmpeg-<ver>-essentials_build.zip
 *   - 其他平台暂不自动拉(报警退出码 0,不阻塞 build,留人工补)。
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { tmpdir, platform, arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BIN_DIR = join(REPO_ROOT, "src-tauri", "binaries");

/** 解析目标三元组,跟 Rust frame_extract.rs 的 FFMPEG_BUNDLED_NAME 保持严格一致。 */
function detectTarget() {
  const p = platform();
  const a = arch();
  if (p === "win32" && a === "x64") {
    return { triple: "x86_64-pc-windows-msvc", ext: ".exe", supported: true };
  }
  if (p === "win32" && a === "arm64") {
    return { triple: "aarch64-pc-windows-msvc", ext: ".exe", supported: false };
  }
  if (p === "darwin" && a === "x64") {
    return { triple: "x86_64-apple-darwin", ext: "", supported: false };
  }
  if (p === "darwin" && a === "arm64") {
    return { triple: "aarch64-apple-darwin", ext: "", supported: false };
  }
  if (p === "linux" && a === "x64") {
    return { triple: "x86_64-unknown-linux-gnu", ext: "", supported: false };
  }
  return { triple: `${a}-unknown-${p}`, ext: "", supported: false };
}

function log(...args) {
  console.log("[fetch-ffmpeg]", ...args);
}

function logErr(...args) {
  console.error("[fetch-ffmpeg]", ...args);
}

/** 把 https.get 包成 Promise,自动跟随 30x 跳转。 */
function httpGet(url, depth = 0) {
  return new Promise((resolvePromise, reject) => {
    if (depth > 5) {
      reject(new Error("redirect depth > 5"));
      return;
    }
    import("node:https").then(({ get }) => {
      const req = get(url, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          httpGet(next, depth + 1).then(resolvePromise, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage} for ${url}`));
          res.resume();
          return;
        }
        resolvePromise(res);
      });
      req.on("error", reject);
    });
  });
}

async function downloadToFile(url, dest) {
  log(`downloading ${url}`);
  const startedAt = Date.now();
  const res = await httpGet(url);
  const total = Number(res.headers["content-length"] || 0);
  const tmp = `${dest}.partial`;
  await new Promise((r, j) => {
    const out = createWriteStream(tmp);
    let received = 0;
    let lastReport = Date.now();
    res.on("data", (chunk) => {
      received += chunk.length;
      const now = Date.now();
      if (now - lastReport > 5000) {
        const pct = total ? ((received / total) * 100).toFixed(1) : "?";
        log(`  ${(received / 1048576).toFixed(1)} MB / ${(total / 1048576).toFixed(1)} MB (${pct}%)`);
        lastReport = now;
      }
    });
    res.pipe(out);
    out.on("finish", () => out.close(r));
    out.on("error", j);
    res.on("error", j);
  });
  renameSync(tmp, dest);
  const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`  → ${dest} (${(total / 1048576).toFixed(1)} MB in ${dur}s)`);
}

/** 调系统 unzip / PowerShell Expand-Archive 解 zip 到目录。Node 内置没有 zip 解压。 */
function spawnUnzip(zipPath, destDir) {
  return new Promise((resolvePromise, reject) => {
    let cmd, args;
    if (platform() === "win32") {
      cmd = "powershell.exe";
      args = [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`,
      ];
    } else {
      cmd = "unzip";
      args = ["-q", "-o", zipPath, "-d", destDir];
    }
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${cmd} exit code ${code}`)),
    );
  });
}

/** 在 extracted 目录里递归找 ffmpeg(.exe)。Gyan 的 zip 都是 ffmpeg-<ver>-essentials_build/bin/ffmpeg.exe。 */
async function findFfmpegBinary(root, ext) {
  const target = `ffmpeg${ext}`;
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        const hit = await walk(full);
        if (hit) return hit;
      } else if (e.name === target) {
        return full;
      }
    }
    return null;
  }
  return walk(root);
}

async function main() {
  const target = detectTarget();
  const finalName = `ffmpeg-${target.triple}${target.ext}`;
  const finalPath = join(BIN_DIR, finalName);

  if (!target.supported) {
    logErr(`platform ${platform()}/${arch()} 暂未支持自动拉取`);
    logErr(`请手动放置 ffmpeg 到 ${finalPath}`);
    logErr(`(build 时若仍缺,tauri 会报错;dev 模式会 fallback 到 PATH/下载)`);
    process.exit(0); // 不阻塞 build:让 cargo 自己报缺文件,信号更清楚
  }

  // 已存在 + 大小合理(>10MB) → 跳过
  if (existsSync(finalPath)) {
    const s = await stat(finalPath);
    if (s.size > 10 * 1024 * 1024) {
      log(`${finalName} 已存在 (${(s.size / 1048576).toFixed(1)} MB),跳过`);
      return;
    }
    log(`${finalName} 存在但 < 10MB,视作残缺,重新拉`);
    await unlink(finalPath);
  }

  if (!existsSync(BIN_DIR)) {
    mkdirSync(BIN_DIR, { recursive: true });
  }

  // 走 gyan.dev,跟 ffmpeg-sidecar 同源
  const url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

  const workDir = join(tmpdir(), "ai-canvas-ffmpeg-fetch");
  await mkdir(workDir, { recursive: true });
  const zipPath = join(workDir, "ffmpeg-release-essentials.zip");
  const extractDir = join(workDir, "extract");

  if (existsSync(zipPath)) {
    const s = await stat(zipPath);
    if (s.size > 80 * 1024 * 1024) {
      log(`复用已下载的 zip (${(s.size / 1048576).toFixed(1)} MB) at ${zipPath}`);
    } else {
      await unlink(zipPath);
      await downloadToFile(url, zipPath);
    }
  } else {
    await downloadToFile(url, zipPath);
  }

  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  log(`unzip → ${extractDir}`);
  await spawnUnzip(zipPath, extractDir);

  const found = await findFfmpegBinary(extractDir, target.ext);
  if (!found) {
    logErr(`unzip 完成但没找到 ffmpeg${target.ext} in ${extractDir}`);
    process.exit(1);
  }
  log(`found ${found}`);

  await rename(found, finalPath);
  const finalStat = await stat(finalPath);
  log(`installed → ${finalPath} (${(finalStat.size / 1048576).toFixed(1)} MB)`);

  // license 也带一份过去(externalBin 走 resources 字段引用)
  const licCandidates = ["LICENSE", "LICENSE.txt", "COPYING"];
  for (const lic of licCandidates) {
    const walked = await (async function walk(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          const hit = await walk(full);
          if (hit) return hit;
        } else if (e.name === lic) {
          return full;
        }
      }
      return null;
    })(extractDir);
    if (walked) {
      const dest = join(BIN_DIR, "FFMPEG-LICENSE.txt");
      try {
        const buf = readFileSync(walked);
        await import("node:fs").then(({ writeFileSync }) =>
          writeFileSync(dest, buf),
        );
        log(`license → ${dest}`);
      } catch (e) {
        logErr(`license 拷贝失败 (非致命): ${e.message}`);
      }
      break;
    }
  }
}

main().catch((e) => {
  logErr(e.stack || e.message || e);
  process.exit(1);
});
