// ── Message Protocol ────────────────────────────────────────

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string; mimeType: string }
  | { type: "file"; path: string; name: string };

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: ContentPart[];
  toolCalls?: ToolCall[];
  toolResult?: { callId: string; output: unknown; success: boolean };
  timestamp: number;
}

// ── Tool System ─────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: (
    args: Record<string, unknown>,
    ctx: AgentContext,
  ) => Promise<ToolOutput>;
}

export interface ToolOutput {
  success: boolean;
  data: unknown;
  artifacts?: Artifact[];
}

export interface Artifact {
  type: "image" | "card" | "file" | "text";
  payload: Record<string, unknown>;
}

// ── Provider System ─────────────────────────────────────────

export type ProviderCapability =
  | "chat"
  | "vision"
  | "tool_calling"
  | "image_gen";

export interface ProviderDescriptor {
  id: string;
  name: string;
  capabilities: ProviderCapability[];
}

// ── Context ─────────────────────────────────────────────────

export interface AgentContext {
  projectId: string;
  sessionId: string;
  model: string;

  createCard: (
    partial: CardCreateInput,
  ) => string;
  updateCard: (id: string, patch: Record<string, unknown>) => void;
  readCard: (id: string) => CardSnapshot | undefined;
  listCards: () => CardSnapshot[];

  callProvider: (
    capability: ProviderCapability,
    request: unknown,
  ) => Promise<unknown>;
}

export interface CardCreateInput {
  type: string;
  title?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  data?: Record<string, unknown>;
}

export interface CardSnapshot {
  id: string;
  type: string;
  title?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  data: Record<string, unknown>;
}

// ── Session ─────────────────────────────────────────────────

export type AgentStatus = "idle" | "thinking" | "calling_tool" | "error";

export interface AgentSession {
  id: string;
  projectId: string;
  messages: AgentMessage[];
  status: AgentStatus;
  activeToolCall?: { name: string; arguments: Record<string, unknown> };
  error?: string;
  createdAt: number;
}

// ── Utility ─────────────────────────────────────────────────

export type JsonSchema = Record<string, unknown>;
