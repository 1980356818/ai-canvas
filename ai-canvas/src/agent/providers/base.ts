import type { ContentPart, ProviderCapability } from "../types";

// ── Chat ────────────────────────────────────────────────────

export interface ChatRequestMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  toolCallId?: string;
}

export interface ChatRequest {
  model: string;
  systemPrompt: string;
  messages: ChatRequestMessage[];
  tools?: FunctionSchema[];
  maxTokens?: number;
}

export interface FunctionSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResponseToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ChatResponseToolCall[];
  usage: { promptTokens: number; completionTokens: number };
  finishReason: "stop" | "tool_calls" | "length";
}

// ── Image Generation ────────────────────────────────────────

export interface ImageGenRequest {
  prompt: string;
  size: string;
  model?: string;
  quality?: string;
  n?: number;
}

export interface ImageGenResponse {
  url: string;
  revisedPrompt?: string;
}

// ── Provider Interface ──────────────────────────────────────

export interface AIProvider {
  readonly descriptor: {
    id: string;
    name: string;
    capabilities: readonly ProviderCapability[];
  };

  chat(req: ChatRequest): Promise<ChatResponse>;

  generateImage?(req: ImageGenRequest): Promise<ImageGenResponse>;
}
