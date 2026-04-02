import { listModels, type ModelInfo } from "@/lib/tauri";

let cachedModels: ModelInfo[] | null = null;
let fetchPromise: Promise<ModelInfo[]> | null = null;

async function ensureLoaded(): Promise<ModelInfo[]> {
  if (cachedModels) return cachedModels;
  if (fetchPromise) return fetchPromise;

  fetchPromise = listModels()
    .then((models) => {
      cachedModels = models;
      fetchPromise = null;
      return models;
    })
    .catch((err) => {
      fetchPromise = null;
      throw err;
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
    return all.filter(
      (m) => !m.capability || m.capability.toUpperCase() === cap,
    );
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
