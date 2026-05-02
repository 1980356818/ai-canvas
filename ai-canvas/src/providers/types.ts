import type { ModelInfo } from "@/types";

// ── Provider 配置 ───────────────────────────────────────────

export interface ProviderConfigField {
  key: string;
  label: string;
  type: "text" | "password" | "url" | "select";
  required: boolean;
  default?: string;
  options?: { value: string; label: string }[];
  placeholder?: string;
}

export interface ProviderConfig {
  id: string;
  apiKey: string;
  baseUrl: string;
  extra: Record<string, string>;
  enabled: boolean;
}

// ── Provider 能力 ───────────────────────────────────────────

export type ProviderCapability =
  | "chat"
  | "vision"
  | "tool_calling"
  | "image_gen"
  | "video_gen"
  | "streaming";

export interface ProviderDescriptor {
  id: string;
  name: string;
  icon?: string;
  capabilities: readonly ProviderCapability[];
  configSchema: ProviderConfigField[];
}

// ── 统一消息格式（平台无关）────────────────────────────────

export interface UnifiedMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: UnifiedContentPart[];
  toolCalls?: UnifiedToolCall[];
  toolCallId?: string;
}

export type UnifiedContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "video"; url: string }
  | { type: "file"; name: string; url: string }
  // 模型 thinking / reasoning 内容（与 text 严格区分，不回传 API）
  | { type: "reasoning"; text: string };

export interface UnifiedToolCall {
  id: string;
  name: string;
  arguments: string;
}

// ── 流式事件 ────────────────────────────────────────────────

export type StreamEvent =
  | { type: "text"; text: string }
  // 思考/推理 delta（独立于 text 的子流；UI 单独渲染）
  | { type: "reasoning"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; arguments: string }
  | { type: "tool_call_end"; id: string }
  | { type: "done" }
  | { type: "error"; message: string };

// ── 请求 / 响应 ────────────────────────────────────────────

export interface ChatRequest {
  model: string;
  systemPrompt: string;
  messages: UnifiedMessage[];
  tools?: FunctionSchema[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface FunctionSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResponse {
  content: string | null;
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
  usage: { promptTokens: number; completionTokens: number };
  finishReason: "stop" | "tool_calls" | "length";
}

export interface ImageRefInput {
  url: string;
  role: string;
}

export interface AudioRefInput {
  url: string;
  role: string;
}

export interface VideoRefInput {
  url: string;
  role: string;
}

export interface GenerationProgress {
  percent: number;
  phase: "submitting" | "queued" | "generating" | "saving";
  label: string;
}

export interface ImageGenRequest {
  prompt?: string;
  model?: string;
  size?: string;
  /** Resolution tier (e.g. "2K", "4K"); used by providers that map size to pixel dimensions. */
  resolution?: string;
  quality?: string;
  n?: number;
  referenceImages?: ImageRefInput[];
  onProgress?: (p: GenerationProgress) => void;
  signal?: AbortSignal;
}

export interface ImageGenResponse {
  url: string;
  revisedPrompt?: string;
}

export interface VideoGenRequest {
  prompt: string;
  model?: string;
  size?: string;
  referenceImages?: ImageRefInput[];
  referenceAudios?: AudioRefInput[];
  referenceVideos?: VideoRefInput[];
  onProgress?: (p: GenerationProgress) => void;
  signal?: AbortSignal;
  duration?: number;
  resolution?: string;
  generateAudio?: boolean;
  seed?: number;
  watermark?: boolean;
}

export interface VideoGenResponse {
  url: string;
}

// ── Provider 接口 ───────────────────────────────────────────

export interface AIProvider {
  readonly descriptor: ProviderDescriptor;

  initialize?(config: ProviderConfig): void;

  listModels(): Promise<ModelInfo[]>;

  /** Synchronous model list for provider resolution (returns static models). */
  listModelsSync?(): ModelInfo[];

  chat(req: ChatRequest): Promise<ChatResponse>;

  streamChat(
    req: ChatRequest,
    onEvent: (event: StreamEvent) => void,
  ): Promise<{ abort: () => void }>;

  generateImage?(req: ImageGenRequest): Promise<ImageGenResponse>;

  generateVideo?(req: VideoGenRequest): Promise<VideoGenResponse>;

  resolveImageModelId?(baseId: string, resolution: string): string;

  getDisplayName?(modelId: string): string | undefined;
}

// ── 增强 ModelInfo ──────────────────────────────────────────

export interface ModelOption extends ModelInfo {
  providerId: string;
  providerName: string;
}
