/**
 * 自动更新 / 版本切换的前端 API + Tauri 命令包装。
 *
 * 三类东西在这里:
 *  1. 服务端 REST: GET /api/update/list/{target}/{arch}  — 列出所有"启用中"版本
 *  2. Tauri 命令: check_for_update / install_latest_update / switch_to_version / get_runtime_info
 *  3. localStorage: 记忆"用户主动跳过过的版本号",避免每次启动反复弹同一个 UpdateDialog
 */

import { invoke } from "@tauri-apps/api/core";
import { lsGet, lsSet } from "./storage";

// ── 服务端 base url ──────────────────────────────────────────────────
// 跟 auth.api.ts 同一个 key,改了一处两处都跟着变。
export function getServerBaseUrl(): string {
  return lsGet<string>("server_base_url", "http://101.37.80.236");
}

// ── 类型 ──────────────────────────────────────────────────────────────

export interface VersionItem {
  id: number;
  version: string;
  versionCode: number;
  target: string;
  arch: string;
  fileSize: number;
  releaseNotes: string | null;
  minVersion: string | null;
  pubDate: string | null;
  downloadUrl: string;
}

export interface UpdateAvailable {
  version: string;
  current_version: string;
  notes: string;
  force_update: boolean;
}

export interface RuntimeInfo {
  target: string;
  arch: string;
  version: string;
}

interface ApiResult<T> {
  code: number;
  msg: string;
  data: T;
}

// ── 服务端 REST ──────────────────────────────────────────────────────

export async function apiListAvailableVersions(
  target: string,
  arch: string,
): Promise<VersionItem[]> {
  const url = `${getServerBaseUrl()}/api/update/list/${target}/${arch}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`列出版本失败: HTTP ${resp.status}`);
  const json: ApiResult<VersionItem[]> = await resp.json();
  if (json.code !== 0) throw new Error(json.msg || "列出版本失败");
  return json.data;
}

// ── Tauri 命令包装 ────────────────────────────────────────────────────

export function getRuntimeInfo(): Promise<RuntimeInfo> {
  return invoke<RuntimeInfo>("get_runtime_info");
}

/** None = 已是最新;Some = 有新版本(下一步前端弹 UpdateDialog) */
export function checkForUpdate(): Promise<UpdateAvailable | null> {
  return invoke<UpdateAvailable | null>("check_for_update");
}

export function installLatestUpdate(): Promise<void> {
  return invoke<void>("install_latest_update");
}

export function switchToVersion(versionId: number): Promise<void> {
  return invoke<void>("switch_to_version", {
    serverBaseUrl: getServerBaseUrl(),
    versionId,
  });
}

// ── 跳过的版本号本地记忆 ───────────────────────────────────────────────

const SKIPPED_KEY = "update_skipped_version";

export function getSkippedVersion(): string | null {
  return lsGet<string | null>(SKIPPED_KEY, null);
}

export function setSkippedVersion(version: string) {
  lsSet(SKIPPED_KEY, version);
}

export function clearSkippedVersion() {
  lsSet(SKIPPED_KEY, null);
}
