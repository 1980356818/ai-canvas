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
  | { type: "done"; finishReason?: "stop" | "tool_calls" | "length" }
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
  /**
   * 任务所属项目 ID。**调用方必须在发起请求前快照**，禁止在异步回调里从全局
   * store 读取，否则用户在生成期间切换项目会导致结果保存到错误的项目目录。
   */
  projectId?: string;
  /**
   * 卡片 ID。**提供时启用 TaskManager 持久化路径**（断网/重启可恢复）。
   * 不提供则走 legacy 直连路径（一次性、不可恢复，适用于 chatStore / agent tools）。
   */
  cardId?: string;
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
  /** 帧数 (frames)，优先级高于 duration。Seedance 1.0 系列支持。 */
  frames?: number;
  resolution?: string;
  /** 显式画面比例 (如 "16:9"、"adaptive")。若提供则覆盖 size 推断。 */
  ratio?: string;
  generateAudio?: boolean;
  seed?: number;
  watermark?: boolean;
  /** 固定镜头。Seedance 2.0 暂不支持。 */
  cameraFixed?: boolean;
  /** 返回视频尾帧图像，便于续生成。 */
  returnLastFrame?: boolean;
  /** 服务等级: default (在线) / flex (离线，价格 50%)。 */
  serviceTier?: "default" | "flex";
  /** 任务超时阈值，单位秒，范围 [3600, 259200]。默认 172800 (48h)。 */
  executionExpiresAfter?: number;
  /** 样片模式 (Seedance 1.5 pro 专属，便宜的预览)。 */
  draft?: boolean;
  /** 终端用户唯一标识 (用于安全审计)。 */
  safetyIdentifier?: string;
  /** Seedance 2.0 工具调用列表，目前支持 web_search。 */
  tools?: Array<{ type: string }>;
  /** 状态变更回调地址。 */
  callbackUrl?: string;
  /**
   * 任务所属项目 ID。**调用方必须在发起请求前快照**，禁止在异步回调里从全局
   * store 读取，否则用户在生成期间切换项目会导致结果保存到错误的项目目录。
   */
  projectId?: string;
  /**
   * 卡片 ID。**提供时启用 TaskManager 持久化路径**（断网/重启可恢复）。
   * 不提供则走 legacy 直连路径（一次性、不可恢复，适用于 chatStore / agent tools）。
   */
  cardId?: string;
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

  resolveImageModelId?(baseId: string, resolution: string, quality?: string): string;

  getDisplayName?(modelId: string): string | undefined;
}

// ── 增强 ModelInfo ──────────────────────────────────────────

export interface ModelOption extends ModelInfo {
  providerId: string;
  providerName: string;
}
