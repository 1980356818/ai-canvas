# 多平台 Provider 架构方案

> 状态：IMPLEMENTED  
> 日期：2026-04-19

---

## 1. 现状诊断

### 1.1 三条并行 AI 调用路径

当前代码中存在 **三条独立的 AI 调用路径**，各自维护格式转换和流解析逻辑：

| 路径 | 入口 | 中间层 | 传输 | 格式绑定 |
|------|------|--------|------|----------|
| **Canvas Agent** | `agentStore.sendMessage()` | `ProviderManager` → `OpenAIProvider` / `SeedanceProvider` | `aiProxy()` | OpenAI / Seedance 独立适配 |
| **Chat Panel** | `chatStore.sendMessage()` | `chatService.chatCompletion()` | `aiProxyStream()` | **硬编码 OpenAI** |
| **Chat Card** | `ChatEditor.tsx` 内联 | 无 | `aiProxy()` 直接调用 | **硬编码 OpenAI** |

**问题**：新增任何平台都需要在三个地方各改一遍。

### 1.2 具体问题清单

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 1 | `chatService.ts` 的 `historyToOpenAI()` 只处理 OpenAI 消息格式 | `lib/chatService.ts:77-107` | Chat Panel 无法切换平台 |
| 2 | `chatService.ts` 流解析硬编码 `delta.choices[0].delta` | `lib/chatService.ts:144-175` | 其他平台流格式不兼容 |
| 3 | `ChatEditor.tsx` 直接拼 OpenAI messages 数组 | `features/editor/ChatEditor.tsx` | Chat Card 无法切换平台 |
| 4 | `models.ts` 静态硬编码模型列表 | `services/models.ts` | 新增平台需改源码 |
| 5 | `aiProxy` 第一个参数全部写死 `"openai"`（包括 Seedance） | 多处 | 语义混乱 |
| 6 | `generation.service.ts` 与 `OpenAIProvider.generateImage` 逻辑重复 | `services/` vs `agent/providers/` | 两套生成逻辑 |
| 7 | Chat 停止按钮的 `AbortController` 未传入 HTTP 请求 | `chatStore.ts` | 取消不生效 |
| 8 | `TryOnEditor` 未传 `referenceImages` 给 generateImage | `features/editor/TryOnEditor.tsx` | 功能缺陷 |

### 1.3 已有的好基础

| 资产 | 位置 | 可复用度 |
|------|------|----------|
| `AIProvider` 接口 | `agent/providers/base.ts` | ★★★★ 扩展即可 |
| `ProviderManager` | `agent/providers/manager.ts` | ★★★ 需增强 |
| `aiProxy` / `aiProxyStream` 传输层 | `platform/ai.api.ts` | ★★★★★ 原样保留 |
| `waitForTask` 轮询机制 | `services/tasks.ts` | ★★★★★ 原样保留 |
| `parseIntent` / `extractSizeFromPrompt` | `lib/chatService.ts` | ★★★★★ 与平台无关 |
| `saveMedia` / `persistImage` 媒体层 | `platform/` + `lib/media.ts` | ★★★★★ 原样保留 |

---

## 2. 目标架构

### 2.1 分层视图

```
┌─────────────────────────────────────────────────────────────────┐
│                           UI Layer                              │
│  ModelSelector · ChatPanel · ChatEditor · MediaEditor · Agent   │
│  只认识 providerService + 统一类型                               │
├─────────────────────────────────────────────────────────────────┤
│                      Provider Facade                            │
│  providerService.streamChat()  .generateImage()  .generateVideo │
│  根据 (providerId, modelId) 路由到具体 Provider                  │
├─────────────────────────────────────────────────────────────────┤
│                     Provider Interface                          │
│  AIProvider { chat, streamChat, generateImage, generateVideo,   │
│               listModels, configSchema }                        │
├──────────┬──────────┬──────────┬──────────┬─────────────────────┤
│  OpenAI  │Anthropic │  Gemini  │ Seedance │ Custom/OAI-compat   │
│ Adapter  │ Adapter  │ Adapter  │ Adapter  │     Adapter         │
│ ──────── │ ──────── │ ──────── │ ──────── │ ─────────────       │
│ format() │ format() │ format() │ format() │ format()            │
│ parse()  │ parse()  │ parse()  │ parse()  │ parse()             │
│ models   │ models   │ models   │ models   │ models              │
├──────────┴──────────┴──────────┴──────────┴─────────────────────┤
│                      Transport Layer                            │
│  aiProxy() · aiProxyStream() — 通用 HTTP / Tauri 传输           │
├─────────────────────────────────────────────────────────────────┤
│                      Platform Layer                             │
│  settings · storage · media · clipboard · viewport              │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 数据流（改造后）

**Chat Panel 流式聊天：**
```
ChatInput → chatStore.sendMessage(text)
  → providerService.streamChat(providerId, { model, messages, tools })
    → registry.get(providerId).streamChat(req, callbacks)
      → OpenAIAdapter: formatMessages() → aiProxyStream() → parseChunk() → callbacks.onText/onToolCall
    ← { abort }
  → chatStore 更新 streamingText
```

**Canvas Card 生成：**
```
MediaEditor → providerService.generateImage(providerId, req)
  → registry.get(providerId).generateImage(req)
    → OpenAIAdapter: buildBody() → aiProxy() → parseTask() → waitForTask() → saveMedia()
  → card.data.imageUrl = result.url
```

**Agent 对话：**
```
AgentPanel → agentStore.sendMessage(text)
  → runAgent(provider, context)    // provider 从 registry 获取
    → provider.chat(req)           // 非流式，与现有一致
```

### 2.3 核心设计原则

1. **Provider 内聚**：每个 Provider 自己负责消息格式化、流解析、endpoint 路由、模型列表。外部不感知平台差异。
2. **统一入口**：所有 AI 调用通过 `providerService` facade，不允许直接调 `aiProxy`。
3. **传输层不变**：`aiProxy` / `aiProxyStream` 只做 HTTP 转发，不处理任何平台逻辑。
4. **配置驱动**：每个 Provider 声明自己需要的配置字段（`configSchema`），Settings UI 动态渲染。
5. **渐进迁移**：每个 Phase 可独立上线，旧路径通过 re-export 兼容。

---

## 3. 类型设计

### 3.1 新增 `types/provider.ts`

```typescript
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
  id: string;           // e.g. "openai", "anthropic"
  apiKey: string;
  baseUrl: string;
  extra: Record<string, string>;
  enabled: boolean;
}

// ── Provider 能力 ───────────────────────────────────────────

export type ProviderCapability = "chat" | "vision" | "tool_calling" | "image_gen" | "video_gen" | "streaming";

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
  | { type: "file"; name: string; url: string };

export interface UnifiedToolCall {
  id: string;
  name: string;
  arguments: string;   // JSON string
}

// ── 流式事件（从 Provider 发出的统一事件）──────────────────

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; arguments: string }
  | { type: "tool_call_end"; id: string }
  | { type: "done" }
  | { type: "error"; message: string };

// ── 请求/响应 ───────────────────────────────────────────────

export interface ChatRequest {
  model: string;
  systemPrompt: string;
  messages: UnifiedMessage[];
  tools?: FunctionSchema[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;         // 支持取消
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
  role: string;       // "reference", "firstFrame", "lastFrame"
}

export interface GenerationProgress {
  percent: number;     // 0-100
  phase: "submitting" | "queued" | "generating" | "saving";
  label: string;
}

export interface ImageGenRequest {
  prompt: string;
  model?: string;
  size?: string;
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
```

### 3.2 Provider 接口（扩展现有 `base.ts`）

```typescript
export interface AIProvider {
  readonly descriptor: ProviderDescriptor;

  /** 初始化（加载配置等），应用启动时调用一次 */
  initialize?(config: ProviderConfig): void;

  /** 获取该 Provider 的模型列表 */
  listModels(): Promise<ModelInfo[]>;

  /** 非流式聊天（Agent 用） */
  chat(req: ChatRequest): Promise<ChatResponse>;

  /** 流式聊天（Chat Panel / Chat Card 用） */
  streamChat(req: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<{ abort: () => void }>;

  /** 图片生成 */
  generateImage?(req: ImageGenRequest): Promise<ImageGenResponse>;

  /** 视频生成 */
  generateVideo?(req: VideoGenRequest): Promise<VideoGenResponse>;
}
```

---

## 4. 目标文件结构

```
src/
  providers/                          # ← 新目录，替代 agent/providers/
    types.ts                          # Provider 统一类型（§3.1）
    base.ts                           # AIProvider 接口（§3.2）
    registry.ts                       # ProviderRegistry（§4.1）
    errors.ts                         # ← 从 agent/providers/errors.ts 迁入
    openai/
      index.ts                        # OpenAIProvider class
      formatter.ts                    # OpenAI 消息格式化 + 流 chunk 解析
      models.ts                       # OpenAI 系模型列表
    seedance/
      index.ts                        # SeedanceProvider class（视频专用）
      models.ts                       # Seedance 模型列表
    anthropic/                        # 未来：Anthropic 适配
      index.ts
      formatter.ts
      models.ts
    custom/                           # OpenAI-compatible 自定义服务
      index.ts
  services/
    provider.service.ts               # ← 新文件，统一 Facade
    models.ts                         # ← 重写：从 registry 动态聚合
    tasks.ts                          # 保留不变
    index.ts                          # 更新 re-export
  stores/
    providerStore.ts                  # ← 新文件，Provider 配置持久化
    chatStore.ts                      # ← 改造：走 providerService
    agentStore.ts                     # ← 改造：从新 registry 取 provider
    settingsStore.ts                  # 保留不变
  lib/
    chatService.ts                    # ← 瘦身：只保留 parseIntent 等通用工具
    media.ts                          # 保留不变
  platform/
    ai.api.ts                         # 保留不变（传输层）
  types/
    provider.ts                       # ← 新文件（§3.1 的类型子集 re-export）
    index.ts                          # 更新 re-export
```

### 4.1 ProviderRegistry

```typescript
// providers/registry.ts

class ProviderRegistry {
  private providers = new Map<string, AIProvider>();
  private configs   = new Map<string, ProviderConfig>();

  /** 注册 Provider（应用启动时） */
  register(provider: AIProvider): void;

  /** 按 id 获取 */
  get(id: string): AIProvider;

  /** 获取所有已注册 Provider */
  getAll(): AIProvider[];

  /** 按能力筛选 */
  getByCapability(cap: ProviderCapability): AIProvider[];

  /** 按能力筛选，且已启用（有 API Key） */
  getEnabledByCapability(cap: ProviderCapability): AIProvider[];

  /** 配置管理 */
  setConfig(id: string, config: ProviderConfig): void;
  getConfig(id: string): ProviderConfig | undefined;

  /** 从持久化存储加载所有配置 */
  async loadConfigs(): Promise<void>;
  async saveConfig(id: string): Promise<void>;
}

export const registry = new ProviderRegistry();
```

### 4.2 providerService Facade

```typescript
// services/provider.service.ts

import { registry } from "@/providers/registry";
import type { ... } from "@/providers/types";

export const providerService = {
  /** 流式聊天 — ChatPanel / ChatCard 统一入口 */
  async streamChat(
    providerId: string,
    req: ChatRequest,
    onEvent: (event: StreamEvent) => void,
  ): Promise<{ abort: () => void }> {
    const provider = registry.get(providerId);
    return provider.streamChat(req, onEvent);
  },

  /** 非流式聊天 — Agent 用 */
  async chat(providerId: string, req: ChatRequest): Promise<ChatResponse> {
    const provider = registry.get(providerId);
    return provider.chat(req);
  },

  /** 图片生成 */
  async generateImage(providerId: string, req: ImageGenRequest): Promise<ImageGenResponse> {
    const provider = registry.get(providerId);
    if (!provider.generateImage) throw new Error(`${provider.descriptor.name} 不支持图片生成`);
    return provider.generateImage(req);
  },

  /** 视频生成 */
  async generateVideo(providerId: string, req: VideoGenRequest): Promise<VideoGenResponse> {
    const provider = registry.get(providerId);
    if (!provider.generateVideo) throw new Error(`${provider.descriptor.name} 不支持视频生成`);
    return provider.generateVideo(req);
  },

  /** 获取支持某能力的模型列表（跨 Provider 聚合） */
  async getModels(capability: ProviderCapability): Promise<(ModelInfo & { providerId: string })[]> {
    const providers = registry.getEnabledByCapability(capability);
    const all = [];
    for (const p of providers) {
      const models = await p.listModels();
      all.push(...models
        .filter(m => matchesCapability(m, capability))
        .map(m => ({ ...m, providerId: p.descriptor.id }))
      );
    }
    return all;
  },

  /** 解析 "providerId:modelId" 格式 */
  parseModelRef(ref: string): { providerId: string; modelId: string } {
    const sep = ref.indexOf(":");
    if (sep < 0) return { providerId: "openai", modelId: ref };
    return { providerId: ref.slice(0, sep), modelId: ref.slice(sep + 1) };
  },
};
```

---

## 5. 各平台适配器设计

### 5.1 OpenAI Adapter

**文件**: `providers/openai/index.ts`

```typescript
export class OpenAIProvider implements AIProvider {
  readonly descriptor = {
    id: "openai",
    name: "OpenAI / 兼容网关",
    capabilities: ["chat", "vision", "tool_calling", "image_gen", "video_gen", "streaming"],
    configSchema: [
      { key: "apiKey", label: "API Key", type: "password", required: true },
      { key: "baseUrl", label: "Base URL", type: "url", required: false, default: "https://api.openai.com" },
    ],
  };

  async listModels() { return OPENAI_MODELS; }

  async chat(req) {
    const messages = formatMessagesForOpenAI(req);   // formatter.ts
    const body = { model: req.model, messages, ... };
    const raw = await aiProxy("openai", "/v1/chat/completions", body);
    return parseOpenAIChatResponse(raw);              // formatter.ts
  }

  async streamChat(req, onEvent) {
    const messages = formatMessagesForOpenAI(req);
    const body = { model: req.model, messages, stream: true, ... };
    const { abort } = await aiProxyStream("openai", "/v1/chat/completions", body, {
      onChunk: (raw) => parseOpenAIStreamChunk(raw, onEvent),  // formatter.ts
      onDone: () => onEvent({ type: "done" }),
      onError: (e) => onEvent({ type: "error", message: e }),
    });
    return { abort };
  }

  async generateImage(req) { /* 复用现有 openai.ts 逻辑 */ }
  async generateVideo(req) { /* 复用现有 openai.ts 逻辑 */ }
}
```

**文件**: `providers/openai/formatter.ts`

```typescript
/** 统一消息 → OpenAI messages 格式 */
export function formatMessagesForOpenAI(req: ChatRequest): OpenAIMessage[] {
  // system 放在 messages[0]
  // content: string | [{ type: "text" }, { type: "image_url", image_url: { url } }]
  // tool_calls / tool_call_id 映射
}

/** OpenAI SSE chunk → StreamEvent */
export function parseOpenAIStreamChunk(raw: string, emit: (e: StreamEvent) => void): void {
  const parsed = JSON.parse(raw);
  const delta = parsed.choices?.[0]?.delta;
  if (delta?.content) emit({ type: "text", text: delta.content });
  if (delta?.tool_calls) { /* tool_call_start / tool_call_delta */ }
}

/** 非流式响应解析 */
export function parseOpenAIChatResponse(raw: AiProxyResponse): ChatResponse { ... }
```

### 5.2 Anthropic Adapter（示例）

**差异点全部封装在 formatter.ts 中：**

```typescript
// providers/anthropic/formatter.ts

export function formatMessagesForAnthropic(req: ChatRequest) {
  // system 作为独立参数，不在 messages 中
  // image → { type: "image", source: { type: "base64", media_type, data } }
  // 无 tool_call_id，用 tool_use + tool_result block
  return {
    system: req.systemPrompt,
    messages: req.messages.filter(m => m.role !== "system").map(formatOne),
  };
}

export function parseAnthropicStreamChunk(raw: string, emit: (e: StreamEvent) => void) {
  const event = JSON.parse(raw);
  switch (event.type) {
    case "content_block_delta":
      if (event.delta.type === "text_delta") emit({ type: "text", text: event.delta.text });
      break;
    case "content_block_start":
      if (event.content_block.type === "tool_use")
        emit({ type: "tool_call_start", id: event.content_block.id, name: event.content_block.name });
      break;
    case "message_stop":
      emit({ type: "done" });
      break;
  }
}
```

### 5.3 Seedance Adapter

从现有 `agent/providers/seedance.ts` 迁入，只保留 `generateVideo`，`chat` 抛异常：

```typescript
export class SeedanceProvider implements AIProvider {
  readonly descriptor = {
    id: "seedance",
    name: "Seedance (豆包)",
    capabilities: ["video_gen"],
    configSchema: [], // 共享 OpenAI 的 API Key（走同一网关）
  };

  listModels() { return SEEDANCE_MODELS; }
  chat() { throw new Error("Seedance 不支持对话"); }
  streamChat() { throw new Error("Seedance 不支持对话"); }
  generateVideo(req) { /* 现有逻辑搬入 */ }
}
```

### 5.4 Custom / OAI-Compatible Adapter

用于自建服务或 Ollama 等 OpenAI 兼容接口。**复用 OpenAI formatter**，仅覆盖 baseUrl 和模型列表：

```typescript
export class CustomProvider implements AIProvider {
  readonly descriptor = {
    id: "custom",
    name: "自定义服务",
    capabilities: ["chat", "streaming"],
    configSchema: [
      { key: "apiKey", label: "API Key", type: "password", required: false },
      { key: "baseUrl", label: "Base URL", type: "url", required: true, placeholder: "http://localhost:11434" },
      { key: "modelId", label: "模型名称", type: "text", required: true, placeholder: "llama3" },
    ],
  };

  // 复用 OpenAI formatter + stream parser，只改 endpoint base
}
```

---

## 6. Store 改造

### 6.1 新增 `providerStore.ts`

```typescript
interface ProviderStoreState {
  /** 各场景的活跃 Provider + Model */
  activeChatRef: string;      // "openai:gemini-3.1-pro"
  activeImageRef: string;     // "openai:nano-banana-pro"
  activeVideoRef: string;     // "openai:veo3.1-fast" 或 "seedance:doubao-..."

  /** Provider 配置 */
  configs: Record<string, ProviderConfig>;

  /** Actions */
  setActiveRef(scene: "chat" | "image" | "video", ref: string): void;
  setProviderConfig(id: string, config: Partial<ProviderConfig>): void;
  loadFromStorage(): Promise<void>;
}
```

### 6.2 chatStore 改造

```diff
- import { chatCompletion, generateImage, generateVideo, ... } from "@/lib/chatService";
+ import { providerService } from "@/services/provider.service";
+ import { useProviderStore } from "@/stores/providerStore";
+ import { parseIntent, extractSizeFromPrompt } from "@/lib/chatService";

  // sendMessage 中：
  if (intent === "chat") {
-   await chatCompletion(history, chatModel, callbacks);
+   const { providerId, modelId } = providerService.parseModelRef(useProviderStore.getState().activeChatRef);
+   const abortCtrl = new AbortController();
+   set({ _abortController: abortCtrl });
+   await providerService.streamChat(providerId, {
+     model: modelId,
+     systemPrompt: "...",
+     messages: history.map(toUnifiedMessage),
+     tools: CHAT_TOOLS,
+     signal: abortCtrl.signal,
+   }, (event) => {
+     switch (event.type) {
+       case "text": set(s => ({ streamingText: s.streamingText + event.text })); break;
+       case "tool_call_start": /* 累积 */ break;
+       case "done": /* 处理 tool calls */ break;
+       case "error": /* 报错 */ break;
+     }
+   });
  }
```

### 6.3 agentStore 改造

```diff
- import { OpenAIProvider } from "@/agent/providers/openai";
- import { SeedanceProvider } from "@/agent/providers/seedance";
+ import { registry } from "@/providers/registry";

- const providerManager = new ProviderManager();
- providerManager.register(new OpenAIProvider());
- providerManager.register(new SeedanceProvider());

  // sendMessage 中：
- const provider = providerManager.getDefault();
+ const provider = registry.get(useProviderStore.getState().activeChatRef.split(":")[0]);
```

### 6.4 ChatEditor 改造

```diff
- import { aiProxy } from "@/platform";
+ import { providerService } from "@/services/provider.service";

  // generate 中：
- const raw = await aiProxy("openai", "/v1/chat/completions", { model, messages, ... });
- const data = JSON.parse(raw.body);
+ const { providerId } = providerService.parseModelRef(model);
+ const resp = await providerService.chat(providerId, {
+   model,
+   systemPrompt,
+   messages: toUnifiedMessages(messages),
+ });
```

---

## 7. models.ts 重写

```typescript
// services/models.ts

import { registry } from "@/providers/registry";
import type { ModelInfo, ProviderCapability } from "@/types";

export interface ModelOption extends ModelInfo {
  providerId: string;
  providerName: string;
}

export const modelService = {
  async getByCapability(capability: ProviderCapability): Promise<ModelOption[]> {
    const providers = registry.getEnabledByCapability(capability);
    const result: ModelOption[] = [];
    for (const p of providers) {
      const models = await p.listModels();
      for (const m of models) {
        if (matchCapability(m, capability)) {
          result.push({ ...m, providerId: p.descriptor.id, providerName: p.descriptor.name });
        }
      }
    }
    return result;
  },

  getDisplayName(modelId: string): string {
    for (const p of registry.getAll()) {
      // 从各 provider 的 models 中查找
    }
    return modelId;
  },

  resolveImageModelId(baseId: string, resolution: string): string {
    // 保留现有逻辑
  },
};
```

ModelSelector UI 可以按 Provider 分组显示：

```
── OpenAI ──────────
  Gemini 3.1 Pro (Thinking)
  Gemini 3.1 Pro
── Anthropic ───────
  Claude Sonnet 4
── 自定义服务 ───────
  llama3
```

---

## 8. Settings UI 动态渲染

```tsx
// features/overlays/SettingsDialog.tsx 中的 Provider 配置区

function ProviderSettings() {
  const providers = registry.getAll();

  return providers.map(p => (
    <Section key={p.descriptor.id} title={p.descriptor.name}>
      {p.descriptor.configSchema.map(field => (
        <ConfigField
          key={field.key}
          field={field}
          value={getConfig(p.descriptor.id, field.key)}
          onChange={(v) => setConfig(p.descriptor.id, field.key, v)}
        />
      ))}
      <TestConnectionButton providerId={p.descriptor.id} />
    </Section>
  ));
}
```

**不需要为每个新平台写设置 UI** — `configSchema` 驱动自动渲染。

---

## 9. 需要删除的旧代码

| 文件 | 理由 | 时机 |
|------|------|------|
| `agent/providers/base.ts` | 合并入 `providers/base.ts` | Phase A |
| `agent/providers/openai.ts` | 迁入 `providers/openai/index.ts` | Phase A |
| `agent/providers/seedance.ts` | 迁入 `providers/seedance/index.ts` | Phase A |
| `agent/providers/manager.ts` | 被 `providers/registry.ts` 替代 | Phase A |
| `agent/providers/errors.ts` | 迁入 `providers/errors.ts` | Phase A |
| `services/generation.service.ts` | 逻辑已在 Provider.generateImage/Video 中 | Phase C |
| `lib/chatService.ts` 中的 `chatCompletion`, `generateImage`, `generateVideo` | 被 providerService 替代 | Phase C |

**保留不删的**（尽管可能看起来多余）：

| 文件 | 理由 |
|------|------|
| `lib/chatService.ts` | 保留 `parseIntent`、`extractSizeFromPrompt`、`generateTitle` |
| `lib/tauri.ts` | re-export shim，确保万一有遗漏引用不会崩 |
| `agent/` 目录中的 `types.ts`, `context.ts`, `tools/`, `runtime.ts` | Agent 运行时，与 Provider 层无关 |

---

## 10. 实施计划

### Phase A — 建立新 Provider 层（不破坏现有功能）

| 步骤 | 内容 | 产出文件 |
|------|------|----------|
| A.1 | 创建 `types/provider.ts`，定义所有统一类型 | `types/provider.ts` |
| A.2 | 创建 `providers/base.ts`，定义扩展后的 `AIProvider` 接口 | `providers/base.ts` |
| A.3 | 创建 `providers/errors.ts`（从 agent/providers/ 迁入） | `providers/errors.ts` |
| A.4 | 创建 `providers/registry.ts` | `providers/registry.ts` |
| A.5 | 创建 `providers/openai/`（迁移 + 拆分 formatter/models） | `providers/openai/*` |
| A.6 | 创建 `providers/seedance/`（迁移） | `providers/seedance/*` |
| A.7 | `tsc --noEmit` 验证 | — |

**风险**：低 — 纯新增文件，不改现有代码。

### Phase B — 统一模型注册 + Provider 配置

| 步骤 | 内容 | 改动文件 |
|------|------|----------|
| B.1 | 创建 `stores/providerStore.ts` | 新文件 |
| B.2 | 重写 `services/models.ts` → 从 registry 聚合 | 改写 |
| B.3 | 更新 `ModelSelector` UI → 按 Provider 分组显示 | 改写 |
| B.4 | 更新 `SettingsDialog` → 动态渲染 Provider 配置 | 改写 |
| B.5 | `tsc --noEmit` + `vite build` 验证 | — |

**风险**：低 — models.ts 改为动态但返回相同数据，UI 变化可控。

### Phase C — 三条路径合并为一条（核心改造）

| 步骤 | 内容 | 改动文件 |
|------|------|----------|
| C.1 | 创建 `services/provider.service.ts` facade | 新文件 |
| C.2 | 改造 `chatStore.ts` → 走 `providerService.streamChat()` | 改写 |
| C.3 | 改造 `ChatEditor.tsx` → 走 `providerService.chat()` | 改写 |
| C.4 | 改造 `agentStore.ts` → 从新 registry 取 provider | 改写 |
| C.5 | 改造 `MediaEditor.tsx` / `VideoEditor.tsx` / 其他 Editor → 走 `providerService` | 改写 |
| C.6 | 瘦身 `lib/chatService.ts` — 移除 `chatCompletion`, `generateImage`, `generateVideo` | 改写 |
| C.7 | 删除 `services/generation.service.ts` | 删除 |
| C.8 | 删除 `agent/providers/` 目录（已迁移到 `providers/`） | 删除 |
| C.9 | 修复 `TryOnEditor` 未传 referenceImages 的 bug | 修复 |
| C.10 | 修复 chatStore abort 未传入 signal 的 bug | 修复 |
| C.11 | `tsc --noEmit` + `vite build` + 手动测试 | — |

**风险**：中 — 核心逻辑替换，需要充分测试。  
**回滚策略**：旧文件以 `.bak` 保留直到 Phase D 完成。

### Phase D — 接入新平台 + 清理

| 步骤 | 内容 |
|------|------|
| D.1 | 创建 `providers/anthropic/`（Claude 适配） |
| D.2 | 创建 `providers/custom/`（自定义 OAI-compatible 服务） |
| D.3 | 删除所有 `.bak` 文件和过渡 re-export |
| D.4 | 清理 Provider 中的 `console.log` → DEBUG 守卫 |
| D.5 | 文档更新 |

**风险**：低 — 扩展新 Provider，不改核心。

---

## 11. 各平台差异对照表

此表记录每个平台在各维度的 API 差异，供 Adapter 开发参考：

| 维度 | OpenAI | Anthropic | Gemini | Seedance | Custom/Ollama |
|------|--------|-----------|--------|----------|---------------|
| **Chat endpoint** | `/v1/chat/completions` | `/v1/messages` | `/v1beta/models/{m}:streamGenerateContent` | N/A | `/v1/chat/completions` |
| **system 位置** | `messages[0].role="system"` | 独立 `system` 参数 | `systemInstruction` 参数 | N/A | 同 OpenAI |
| **图片传入** | `image_url: { url }` | `image: { source: { type:"base64" } }` | `inlineData: { mimeType, data }` | N/A | 同 OpenAI |
| **流 chunk 格式** | `choices[0].delta.content` | `content_block_delta.delta.text` | `candidates[0].content.parts[0].text` | N/A | 同 OpenAI |
| **流结束标记** | `data: [DONE]` | `event: message_stop` | 无显式标记（流结束） | N/A | 同 OpenAI |
| **Tool calling** | `tool_calls` in delta | `tool_use` content block | `functionCall` in parts | N/A | 可能不支持 |
| **Image gen endpoint** | `/v1/images/generations` | N/A | chat 内生成 | N/A | N/A |
| **Video gen endpoint** | `/v2/videos/generations` | N/A | N/A | `/seedance/v3/contents/generations/tasks` | N/A |
| **异步轮询** | `task_id` → `/v1/tasks/{id}` | N/A | N/A | `id` → Seedance endpoint | N/A |

---

## 12. 扩展新平台的标准流程

当需要接入一个新平台时，只需 3 个文件：

```
providers/
  new-platform/
    index.ts          # 实现 AIProvider 接口
    formatter.ts      # 消息格式化 + 流解析
    models.ts         # 模型列表
```

然后在注册入口添加一行：

```typescript
registry.register(new NewPlatformProvider());
```

**不需要改动**：chatStore、ChatEditor、ModelSelector、SettingsDialog —— 它们都是通过 registry 和 configSchema 动态适配的。

---

## 附录 A — 全局调用链路图（改造后）

```
  ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
  │ChatPanel │     │ChatEditor│     │MediaEditor│     │AgentPanel│
  │(chatStore│     │(component│     │(component)│     │(agentStore
  │.sendMsg) │     │ inline)  │     │           │     │.sendMsg) │
  └────┬─────┘     └────┬─────┘     └────┬──────┘     └────┬─────┘
       │                │                │                  │
       ▼                ▼                ▼                  ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                   providerService (facade)                  │
  │  .streamChat()     .chat()      .generateImage()     .chat()│
  └────────────────────────┬────────────────────────────────────┘
                           │ registry.get(providerId)
                           ▼
  ┌──────────┬──────────┬──────────┬──────────┬──────────────────┐
  │  OpenAI  │Anthropic │  Gemini  │ Seedance │    Custom        │
  │ Provider │ Provider │ Provider │ Provider │   Provider       │
  │ format() │ format() │ format() │ format() │   format()       │
  │ parse()  │ parse()  │ parse()  │ parse()  │   parse()        │
  └────┬─────┴────┬─────┴────┬─────┴────┬─────┴───────┬──────────┘
       │          │          │          │             │
       ▼          ▼          ▼          ▼             ▼
  ┌─────────────────────────────────────────────────────────────┐
  │              aiProxy() / aiProxyStream()                    │
  │              (HTTP / Tauri transport)                        │
  └─────────────────────────────────────────────────────────────┘
```
