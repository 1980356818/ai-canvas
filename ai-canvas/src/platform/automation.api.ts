/**
 * 自动化桥的 Rust 命令桥接。前端 host 与设置界面经此调 Rust 的 automation_* 命令。
 * 非 Tauri (纯浏览器) 环境下自动化桥不可用,所有调用安全降级。
 */

import { isTauri, ensureTauriAPIs, getInvoke } from "./runtime";
import type { CallResponse } from "@/services/automation/types";

export interface AutomationStatus {
  running: boolean;
  port?: number;
  token?: string;
  apiVersion: number;
}

export async function automationStatus(): Promise<AutomationStatus> {
  if (!isTauri) return { running: false, apiVersion: 1 };
  await ensureTauriAPIs();
  return getInvoke()<AutomationStatus>("automation_status");
}

export async function automationStart(): Promise<AutomationStatus> {
  if (!isTauri) return { running: false, apiVersion: 1 };
  await ensureTauriAPIs();
  return getInvoke()<AutomationStatus>("automation_start");
}

export async function automationStop(): Promise<void> {
  if (!isTauri) return;
  await ensureTauriAPIs();
  await getInvoke()("automation_stop");
}

export async function automationRespond(response: CallResponse): Promise<void> {
  if (!isTauri) return;
  await ensureTauriAPIs();
  await getInvoke()("automation_respond", { response });
}

export async function automationSetDescriptor(descriptor: unknown): Promise<void> {
  if (!isTauri) return;
  await ensureTauriAPIs();
  await getInvoke()("automation_set_descriptor", { descriptor });
}

export async function automationLogTail(lines: number): Promise<string[]> {
  if (!isTauri) return [];
  await ensureTauriAPIs();
  return getInvoke()<string[]>("automation_log_tail", { lines });
}
