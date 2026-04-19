import { registry } from "@/providers/registry";
import type {
  ChatRequest,
  ChatResponse,
  StreamEvent,
  ImageGenRequest,
  ImageGenResponse,
  VideoGenRequest,
  VideoGenResponse,
} from "@/providers/types";

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

  getProvider(id: string) {
    return registry.get(id);
  },

  getAllProviders() {
    return registry.getAll();
  },
};
