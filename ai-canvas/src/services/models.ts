import { type ModelInfo } from "@/lib/tauri";

const CHAT_MODELS: ModelInfo[] = [
  { id: "deepseek-v3.2", capability: "CHAT" },
  { id: "gpt-5.4", capability: "CHAT" },
  { id: "gemini-3-flash-preview", capability: "CHAT" },
  { id: "gemini-3.1-pro-preview", capability: "CHAT" },
];

const IMAGE_MODELS: ModelInfo[] = [
  { id: "firered-image-edit1.1", capability: "IMAGE" },
  { id: "nano-banana-2", capability: "IMAGE" },
  { id: "nano-banana-2-4k", capability: "IMAGE" },
];

const ALL_MODELS: ModelInfo[] = [...CHAT_MODELS, ...IMAGE_MODELS];

export const modelService = {
  async getAll(): Promise<ModelInfo[]> {
    return ALL_MODELS;
  },

  async getByCapability(capability: string): Promise<ModelInfo[]> {
    const cap = capability.toUpperCase();
    return cap === "IMAGE" ? IMAGE_MODELS : CHAT_MODELS;
  },

  async getChatModels(): Promise<ModelInfo[]> {
    return this.getByCapability("CHAT");
  },

  async getImageModels(): Promise<ModelInfo[]> {
    return this.getByCapability("IMAGE");
  },

  async getDefaultChatModel(): Promise<string> {
    return CHAT_MODELS[0]!.id;
  },

  async getDefaultImageModel(): Promise<string> {
    return IMAGE_MODELS[0]!.id;
  },

  invalidateCache() {},
};
