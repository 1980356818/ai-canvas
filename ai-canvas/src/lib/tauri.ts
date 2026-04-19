// Re-export everything from the new platform layer.
// This file is kept for backward compatibility during migration.
// Once all imports are updated to use @/platform, this file can be deleted.

export * from "@/platform";

export type {
  CardRow,
  AiProxyResponse,
  SaveMediaResult,
  StreamCallbacks,
  ModelInfo,
  TaskInfo,
  ConnectionRow,
  ChatSessionRow,
  ChatMessageRow,
  SavedViewport,
  FileDropCallback,
} from "@/types";
