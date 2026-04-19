import type { ModelInfo } from "@/types";
import { registry } from "@/providers/registry";
import type { ModelOption, ProviderCapability } from "@/providers/types";

function matchCapability(m: ModelInfo, cap: string): boolean {
  const mc = (m.capability ?? "").toUpperCase();
  switch (cap.toUpperCase()) {
    case "CHAT": return mc === "CHAT" || mc === "";
    case "IMAGE": return mc === "IMAGE";
    case "VIDEO": return mc === "VIDEO";
    default: return true;
  }
}

async function aggregateModels(capability: string): Promise<ModelOption[]> {
  const cap = capability.toUpperCase();
  const provCap: ProviderCapability =
    cap === "IMAGE" ? "image_gen" : cap === "VIDEO" ? "video_gen" : "chat";
  const providers = registry.getEnabledByCapability(provCap);
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
}

export const modelService = {
  async getAll(): Promise<ModelOption[]> {
    const providers = registry.getAll();
    const result: ModelOption[] = [];
    for (const p of providers) {
      const models = await p.listModels();
      result.push(...models.map(m => ({
        ...m,
        providerId: p.descriptor.id,
        providerName: p.descriptor.name,
      })));
    }
    return result;
  },

  async getByCapability(capability: string): Promise<ModelOption[]> {
    return aggregateModels(capability);
  },

  async getChatModels(): Promise<ModelOption[]> {
    return aggregateModels("CHAT");
  },

  async getImageModels(): Promise<ModelOption[]> {
    return aggregateModels("IMAGE");
  },

  async getVideoModels(): Promise<ModelOption[]> {
    return aggregateModels("VIDEO");
  },

  async getDefaultChatModel(): Promise<string> {
    const models = await aggregateModels("CHAT");
    return models[0]?.id ?? "gemini-3.1-pro-preview-thinking-high";
  },

  async getDefaultImageModel(): Promise<string> {
    const models = await aggregateModels("IMAGE");
    return models[0]?.id ?? "gemini-3.1-flash-image-preview";
  },

  async getDefaultVideoModel(): Promise<string> {
    const models = await aggregateModels("VIDEO");
    return models[0]?.id ?? "veo3.1-fast";
  },

  resolveImageModelId(baseId: string, resolution: string, providerId?: string): string {
    const provider = providerId ? registry.tryGet(providerId) : undefined;
    return provider?.resolveImageModelId?.(baseId, resolution) ?? baseId;
  },

  getDisplayName(modelId: string, providerId?: string): string {
    if (providerId) {
      const name = registry.tryGet(providerId)?.getDisplayName?.(modelId);
      if (name) return name;
    }
    for (const p of registry.getAll()) {
      const name = p.getDisplayName?.(modelId);
      if (name) return name;
    }
    return modelId;
  },

  invalidateCache() {},
};
