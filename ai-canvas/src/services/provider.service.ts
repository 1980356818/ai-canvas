import { registry } from "@/providers/registry";
import type {
  ChatRequest,
  ChatResponse,
  StreamEvent,
  ImageGenRequest,
  ImageGenResponse,
  VideoGenRequest,
  VideoGenResponse,
  ModelOption,
  ProviderCapability,
} from "@/providers/types";
import type { ModelInfo } from "@/types";

function matchCapability(m: ModelInfo, cap: ProviderCapability): boolean {
  const mc = (m.capability ?? "").toUpperCase();
  switch (cap) {
    case "chat": return mc === "CHAT" || mc === "";
    case "image_gen": return mc === "IMAGE";
    case "video_gen": return mc === "VIDEO";
    case "streaming": return mc === "CHAT" || mc === "";
    default: return true;
  }
}

export const providerService = {
  async streamChat(
    providerId: string,
    req: ChatRequest,
    onEvent: (event: StreamEvent) => void,
  ): Promise<{ abort: () => void }> {
    const provider = registry.get(providerId);
    return provider.streamChat(req, onEvent);
  },

  async chat(providerId: string, req: ChatRequest): Promise<ChatResponse> {
    const provider = registry.get(providerId);
    return provider.chat(req);
  },

  async generateImage(
    providerId: string,
    req: ImageGenRequest,
  ): Promise<ImageGenResponse> {
    const provider = registry.get(providerId);
    if (!provider.generateImage) {
      throw new Error(`${provider.descriptor.name} 不支持图片生成`);
    }
    return provider.generateImage(req);
  },

  async generateVideo(
    providerId: string,
    req: VideoGenRequest,
  ): Promise<VideoGenResponse> {
    const provider = registry.get(providerId);
    if (!provider.generateVideo) {
      throw new Error(`${provider.descriptor.name} 不支持视频生成`);
    }
    return provider.generateVideo(req);
  },

  async getModels(capability: ProviderCapability): Promise<ModelOption[]> {
    const providers = registry.getEnabledByCapability(capability);
    const result: ModelOption[] = [];
    for (const p of providers) {
      const models = await p.listModels();
      for (const m of models) {
        if (matchCapability(m, capability)) {
          result.push({
            ...m,
            providerId: p.descriptor.id,
            providerName: p.descriptor.name,
          });
        }
      }
    }
    return result;
  },

  getProvider(id: string) {
    return registry.get(id);
  },

  getAllProviders() {
    return registry.getAll();
  },
};
