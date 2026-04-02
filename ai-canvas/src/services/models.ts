import { listModels, type ModelInfo } from "@/lib/tauri";

const FALLBACK_CHAT: ModelInfo[] = [
  { id: "gpt-5.4", capability: "CHAT" },
  { id: "gpt-5-nano", capability: "CHAT" },
  { id: "claude-sonnet-4-6", capability: "CHAT" },
  { id: "claude-haiku-4-5-20251001", capability: "CHAT" },
  { id: "deepseek-v3.2", capability: "CHAT" },
  { id: "gemini-2.0-flash", capability: "CHAT" },
  { id: "qwen3-max", capability: "CHAT" },
  { id: "kimi-k2.5", capability: "CHAT" },
  { id: "glm-5", capability: "CHAT" },
];

const FALLBACK_IMAGE: ModelInfo[] = [
  { id: "gpt-image-1.5", capability: "IMAGE" },
  { id: "grok-4.2-image", capability: "IMAGE" },
  { id: "jimeng-5.0-lite", capability: "IMAGE" },
  { id: "nano-banana-pro", capability: "IMAGE" },
  { id: "flux2-klein-9b", capability: "IMAGE" },
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
      return models[0]?.id ?? "deepseek-v3.2";
    } catch {
      return "deepseek-v3.2";
    }
  },

  async getDefaultImageModel(): Promise<string> {
    try {
      const models = await this.getImageModels();
      return models[0]?.id ?? "gpt-image-1.5";
    } catch {
      return "gpt-image-1.5";
    }
  },

  invalidateCache() {
    cachedModels = null;
    fetchPromise = null;
  },
};
