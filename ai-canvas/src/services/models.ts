import { listModels, type ModelInfo } from "@/lib/tauri";

const FALLBACK_CHAT: ModelInfo[] = [
  { id: "gpt-4o", capability: "CHAT" },
  { id: "gpt-4o-mini", capability: "CHAT" },
  { id: "gpt-4.1", capability: "CHAT" },
  { id: "gpt-4.1-mini", capability: "CHAT" },
  { id: "o4-mini", capability: "CHAT" },
  { id: "o3-mini", capability: "CHAT" },
  { id: "deepseek-chat", capability: "CHAT" },
];

const FALLBACK_IMAGE: ModelInfo[] = [
  { id: "dall-e-3", capability: "IMAGE" },
  { id: "gpt-image-1", capability: "IMAGE" },
  { id: "flux-1-dev", capability: "IMAGE" },
];

let cachedModels: ModelInfo[] | null = null;
let fetchPromise: Promise<ModelInfo[]> | null = null;

async function ensureLoaded(): Promise<ModelInfo[]> {
  if (cachedModels) return cachedModels;
  if (fetchPromise) return fetchPromise;

  fetchPromise = listModels()
    .then((models) => {
      cachedModels = models;
      fetchPromise = null;
      return cachedModels;
    })
    .catch(() => {
      cachedModels = [];
      fetchPromise = null;
      return cachedModels;
    });

  return fetchPromise;
}

export const modelService = {
  async getAll(): Promise<ModelInfo[]> {
    return ensureLoaded();
  },

  async getByCapability(capability: string): Promise<ModelInfo[]> {
    const all = await ensureLoaded();
    const cap = capability.toUpperCase();

    const matched = all.filter(
      (m) => m.capability && m.capability.toUpperCase() === cap,
    );
    const untagged = all.filter((m) => !m.capability);

    if (matched.length > 0) return matched;

    if (untagged.length > 0) return untagged;

    const fallback = cap === "IMAGE" ? FALLBACK_IMAGE : FALLBACK_CHAT;
    return fallback;
  },

  async getChatModels(): Promise<ModelInfo[]> {
    return this.getByCapability("CHAT");
  },

  async getImageModels(): Promise<ModelInfo[]> {
    return this.getByCapability("IMAGE");
  },

  async getDefaultChatModel(): Promise<string> {
    try {
      const models = await this.getChatModels();
      return models[0]?.id ?? "gpt-4o";
    } catch {
      return "gpt-4o";
    }
  },

  async getDefaultImageModel(): Promise<string> {
    try {
      const models = await this.getImageModels();
      return models[0]?.id ?? "dall-e-3";
    } catch {
      return "dall-e-3";
    }
  },

  invalidateCache() {
    cachedModels = null;
    fetchPromise = null;
  },
};
