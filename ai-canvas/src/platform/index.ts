export { isTauri } from "./runtime";
export { lsGet, lsSet, lsRemove, buildProxyUrl } from "./storage";
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
} from "./project.api";

export { loadCards, saveCardsBatch, deleteCard } from "./card.api";

export {
  loadConnections,
  saveConnections,
  clearProjectConnections,
} from "./connection.api";

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
