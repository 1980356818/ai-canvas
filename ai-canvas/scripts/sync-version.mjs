/**
 * Single source of truth: package.json → tauri.conf.json + Cargo.toml
 *
 * Run automatically via beforeDevCommand / beforeBuildCommand,
 * or manually with `npm run version:sync`.
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = resolve(root, "src-tauri");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
const version = pkg.version;

// ── tauri.conf.json ──
const tauriConfPath = resolve(tauriDir, "tauri.conf.json");
const tauriConf = JSON.parse(readFileSync(tauriConfPath, "utf-8"));
if (tauriConf.version !== version) {
  tauriConf.version = version;
  writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n");
  console.log(`[sync-version] tauri.conf.json → ${version}`);
} else {
  console.log(`[sync-version] tauri.conf.json already ${version}`);
}

// ── Cargo.toml ──
const cargoPath = resolve(tauriDir, "Cargo.toml");
let cargo = readFileSync(cargoPath, "utf-8");
const cargoVersionRe = /^(version\s*=\s*")([^"]+)(")/m;
const match = cargo.match(cargoVersionRe);
if (match && match[2] !== version) {
  cargo = cargo.replace(cargoVersionRe, `$1${version}$3`);
  writeFileSync(cargoPath, cargo);
  console.log(`[sync-version] Cargo.toml      → ${version}`);
} else {
  console.log(`[sync-version] Cargo.toml      already ${version}`);
}
