import type { ModelInfo } from "@/types";
import { registry } from "@/providers/registry";
import type { AIProvider, ModelOption, ProviderCapability } from "@/providers/types";

// ── Types ────────────────────────────────────────────────────

export interface ModelRef {
  modelId: string;
  providerId: string;
}

// ── Helpers ──────────────────────────────────────────────────

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

function toRef(m: ModelOption | undefined, fallbackModel: string, fallbackProvider: string): ModelRef {
  return m
    ? { modelId: m.id, providerId: m.providerId }
    : { modelId: fallbackModel, providerId: fallbackProvider };
}

// ── Service ──────────────────────────────────────────────────

export const modelService = {

  /**
   * Resolve a provider instance for the given model.
   *
   * 1. If `providerId` is supplied and registered → return it.
   * 2. Otherwise scan all providers' static models for a match.
   * 3. If nothing found → throw (never silently fall back).
   */
  resolveProvider(modelId: string, providerId?: string): AIProvider {
    if (providerId) {
      const p = registry.tryGet(providerId);
      if (p) return p;
      console.warn(`[resolveProvider] "${providerId}" 未注册，按 modelId 反查`);
    }
    for (const p of registry.getAll()) {
      const hit = p.listModelsSync?.() ?? [];
      if (hit.some((m) => m.id === modelId)) return p;
    }
    throw new Error(`无法找到模型 "${modelId}" 对应的平台，请在设置中检查平台配置`);
  },

  /**
   * Resolve provider, returning `undefined` instead of throwing when not found.
   */
  tryResolveProvider(modelId: string, providerId?: string): AIProvider | undefined {
    try {
      return modelService.resolveProvider(modelId, providerId);
    } catch {
      return undefined;
    }
  },

  // ── Aggregation ──────────────────────────────────────────

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

  // ── Defaults (return full ModelRef) ──────────────────────

  async getDefaultChatModel(): Promise<ModelRef> {
    const models = await aggregateModels("CHAT");
    // 聊天默认走极境,Comfly 不再暴露 chat 模型。
    return toRef(models[0], "gemini-3.1-pro-preview", "jijing");
  },

  async getDefaultImageModel(): Promise<ModelRef> {
    const models = await aggregateModels("IMAGE");
    return toRef(models[0], "gemini-3.1-flash-image-preview", "comfly");
  },

  async getDefaultVideoModel(): Promise<ModelRef> {
    const models = await aggregateModels("VIDEO");
    // 视频默认走极境的 canonical alias "veo3.1";VideoEditor 加载时会通过
    // normalizeVeoModelToCanonical 把任何 legacy sku (-fast/-4k/-ref) 收敛到这里。
    return toRef(models[0], "veo3.1", "jijing");
  },

  // ── Resolution helpers ───────────────────────────────────

  resolveImageModelId(baseId: string, resolution: string, quality?: string, providerId?: string): string {
    const provider = providerId ? registry.tryGet(providerId) : undefined;
    return provider?.resolveImageModelId?.(baseId, resolution, quality) ?? baseId;
  },

  /**
   * Whether a given image model exposes a 2K/4K resolution selector in the UI.
   *
   * Two patterns are supported:
   * 1. ID-swap models (nano-banana, gemini flash) → resolveImageModelId returns a different id
   * 2. Size-map models (gpt-image-2) → same id, but body.size carries pixel dimensions
   */
  supportsImageResolution(baseId: string, providerId?: string): boolean {
    if (!baseId) return false;
    if (baseId.toLowerCase().startsWith("gpt-image-2")) return true;
    return modelService.resolveImageModelId(baseId, "4K", providerId) !== baseId;
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
