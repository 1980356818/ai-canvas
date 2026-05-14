import { isTauri, ensureTauriAPIs, getInvoke } from "./runtime";

export interface BackupInfo {
  /** 备份文件绝对路径 */
  path: string;
  /** 文件名，含扩展名 */
  name: string;
  /** 文件大小（字节） */
  size: number;
  /** 修改时间，毫秒 epoch */
  modified_ms: number;
}

async function call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) {
    throw new Error("备份功能仅在桌面端可用");
  }
  await ensureTauriAPIs();
  return getInvoke()<T>(name, args);
}

export function listBackups(): Promise<BackupInfo[]> {
  return call<BackupInfo[]>("list_backups");
}

export function getBackupDir(): Promise<string> {
  return call<string>("get_backup_dir");
}

export function createBackupNow(): Promise<string> {
  return call<string>("create_backup_now");
}

/** 安排"下次启动时恢复"，写挂起标记 */
export function prepareRestore(backupPath: string): Promise<void> {
  return call<void>("prepare_restore", { backupPath });
}

export function cancelPendingRestore(): Promise<void> {
  return call<void>("cancel_pending_restore");
}

export function getPendingRestore(): Promise<string | null> {
  return call<string | null>("get_pending_restore");
}
