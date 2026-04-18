// ── Domain types ─────────────────────────────────────────────

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string; prompt?: string }
  | { type: "video"; url: string; prompt?: string; coverUrl?: string }
  | { type: "loading"; mediaType: "image" | "video" };

export type Intent = "chat" | "image" | "video";

export interface IntentResult {
  intent: Intent;
  prompt: string;
}

export interface ChatServiceCallbacks {
  onStreamChunk?: (text: string) => void;
  onStreamDone?: () => void;
  onIntentDetected?: (intent: Intent) => void;
  onMediaGenerating?: (mediaType: "image" | "video") => void;
  onMediaProgress?: (progress: number, status: string) => void;
}

export interface ChatHistoryMessage {
  role: "user" | "assistant" | "system";
  content: ChatContentPart[];
}

export interface ChatSession {
  id: string;
  projectId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: ChatContentPart[];
  metadata?: {
    model?: string;
    intent?: Intent;
  };
  createdAt: string;
}

// ── DB row types ─────────────────────────────────────────────

export interface ChatSessionRow {
  id: string;
  project_id: string | null;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  metadata: string | null;
  created_at: string;
}
