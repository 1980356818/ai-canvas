export { registry, ProviderRegistry } from "./registry";
export { OpenAIProvider } from "./openai";
export { SeedanceProvider } from "./seedance";
export { CustomProvider } from "./custom";
export { ApiError, parseApiError, throwIfError } from "./errors";

export type {
  AIProvider,
  ProviderConfig,
  ProviderConfigField,
  ProviderDescriptor,
  ProviderCapability,
  UnifiedMessage,
  UnifiedContentPart,
  UnifiedToolCall,
  StreamEvent,
  ChatRequest,
  ChatResponse,
  FunctionSchema,
  ImageRefInput,
  GenerationProgress,
  ImageGenRequest,
  ImageGenResponse,
  VideoGenRequest,
  VideoGenResponse,
  ModelOption,
} from "./types";

// ── Bootstrap: Register all built-in providers ──────────────

import { registry } from "./registry";
import { OpenAIProvider } from "./openai";
import { SeedanceProvider } from "./seedance";

registry.register(new OpenAIProvider());
registry.register(new SeedanceProvider());
