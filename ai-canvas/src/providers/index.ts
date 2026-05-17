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
import { registerMediaHandlers } from "./shared/mediaHandler";

/** OpenAI 兼容图像 API 的同步快路径：`data[0].url` + `revised_prompt`。 */
const openaiCompatSyncResult = (data: unknown) => {
  const d = data as { data?: Array<{ url?: string; revised_prompt?: string }> };
  const img = d.data?.[0];
  if (img?.url) {
    return { url: img.url, revisedPrompt: img.revised_prompt };
  }
  return null;
};

function registerBuiltins() {
  registry.register(new ComflyProvider());
  // Comfly 同时承载 Seedance / Veo（两者都通过 providerId="comfly" 出网），
  // 这里的 handler 覆盖 image_gen / video_gen / audio_gen 三种 kind。
  registerMediaHandlers("comfly", { trySyncResult: openaiCompatSyncResult });

  if (isPlatformVisible("jijing")) {
    registry.register(new JiJingProvider());
    registerMediaHandlers("jijing", { trySyncResult: openaiCompatSyncResult });
  }
}

registerBuiltins();

if (import.meta.hot) {
  import.meta.hot.accept(
    [
      "./registry",
      "./comfly",
      "./jijing",
      "./shared/mediaHandler",
      "@/config/platforms",
    ],
    () => {
      registerBuiltins();
      // configs map lives on the registry singleton — when that gets replaced
      // we also lose the per-provider `enabled` flag, so reload it here.
      void registry.loadConfigs();
    },
  );
}
