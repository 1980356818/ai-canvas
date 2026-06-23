export { isTauri } from "./runtime";
export { lsGet, lsSet, lsRemove } from "./storage";
// 上行 HTTP 统一入口 —— 见 httpAdapter.ts 顶部注释。
// 任何上游请求一律走 httpJson / httpJsonRequest / httpUploadBytes,
// 禁止前端用 fetch(absoluteUrl)。ESLint 规则 + check-ipc-guards.mjs 会拦截。
export { httpJson, httpJsonRequest, httpUploadBytes } from "./httpAdapter";
export type { HttpJsonOptions, HttpMethod, HttpResponse, UploadResult, UploadBytesOptions } from "./httpAdapter";
export {
  readProviderKeys,
  readProviderFirstKey,
  resolveAuthHeaders,
  setActiveKey,
  isAutoRotateEnabled,
} from "./auth";
export type { ProviderKeyEntry } from "./auth";
export { apiLogin, apiRegister, apiRedeem, apiGetUserStatus, getToken, clearAuth } from "./auth.api";
export type { AuthUser, LoginResult } from "./auth.api";

export {
  listProjects,
  createProject,
  deleteProject,
  listDeletedProjects,
  restoreProject,
  permanentlyDeleteProject,
  renameProject,
  updateProjectMeta,
  exportProject,
  importProject,
} from "./project.api";
export type { ExportSummary } from "./project.api";

export { loadCards, saveCardsBatch, deleteCard } from "./card.api";

export {
  loadConnections,
  saveConnections,
  clearProjectConnections,
} from "./connection.api";

export { loadGroups, saveGroupsBatch, deleteGroup } from "./group.api";

export {
  listChatSessions,
  createChatSession,
  renameChatSession,
  deleteChatSession,
  loadChatMessages,
  saveChatMessage,
  clearChatMessages,
} from "./chat.api";

export {
  aiProxy,
  aiProxyStream,
  listModels,
  pollTask,
  validateConnection,
  normalizeTaskInfo,
} from "./ai.api";

export { saveMedia, readMediaBase64 } from "./media.api";

export {
  getSetting,
  setSetting,
  hasApiKey,
  invalidateApiKeyCache,
  migrateApiConfig,
} from "./settings.api";

export {
  saveProjectViewport,
  loadProjectViewport,
  removeProjectViewport,
} from "./viewport.api";

export { clipboardWriteText, clipboardReadText } from "./clipboard.api";

export { pickDirectory } from "./dialog.api";

export { onTauriFileDrop } from "./file-drop";

export {
  listBackups,
  getBackupDir,
  createBackupNow,
  prepareRestore,
  cancelPendingRestore,
  getPendingRestore,
} from "./backup.api";
export type { BackupInfo } from "./backup.api";

export {
  upsertTask,
  getTask,
  listPendingTasks,
  listTasksByCard,
  deleteTask,
  cleanupTerminalTasks,
  listTasksByProject,
} from "./tasks.api";

// automation: 本地自动化桥的 Rust 命令桥接 (start/stop/status/respond/...)。
export {
  automationStatus,
  automationStart,
  automationStop,
  automationRespond,
  automationSetDescriptor,
  automationLogTail,
} from "./automation.api";
export type { AutomationStatus } from "./automation.api";
