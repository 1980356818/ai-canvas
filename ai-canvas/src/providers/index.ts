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
//
// Registration is a module-level side effect. Vite HMR can replace the
// `./registry` module (creating a fresh, empty singleton) without re-running
// this file, leaving downstream consumers with an empty registry. The HMR
// hooks below re-seed the registry whenever any input module is replaced.

import { registry } from "./registry";
import { ComflyProvider } from "./comfly";
import { JiJingProvider } from "./jijing";
import { isPlatformVisible } from "@/config/platforms";

function registerBuiltins() {
  registry.register(new ComflyProvider());
  if (isPlatformVisible("jijing")) {
    registry.register(new JiJingProvider());
  }
}

registerBuiltins();

if (import.meta.hot) {
  import.meta.hot.accept(
    ["./registry", "./comfly", "./jijing", "@/config/platforms"],
    () => {
      registerBuiltins();
      // configs map lives on the registry singleton — when that gets replaced
      // we also lose the per-provider `enabled` flag, so reload it here.
      void registry.loadConfigs();
    },
  );
}
