export { registry, ProviderRegistry } from "./registry";
export { ComflyProvider } from "./comfly";
export { JiJingProvider } from "./jijing";
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
import { ComflyProvider } from "./comfly";
import { JiJingProvider } from "./jijing";
import { isPlatformVisible } from "@/config/platforms";

registry.register(new ComflyProvider());
if (isPlatformVisible("jijing")) {
  registry.register(new JiJingProvider());
}
