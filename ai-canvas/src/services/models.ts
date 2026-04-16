import { type ModelInfo } from "@/lib/tauri";

const CHAT_MODELS: ModelInfo[] = [
  { id: "gemini-3.1-pro-preview-thinking-high", display_name: "Gemini 3.1 Pro (Thinking)", capability: "CHAT" },
  { id: "gemini-3.1-pro-preview", display_name: "Gemini 3.1 Pro", capability: "CHAT" },
];

const IMAGE_MODELS: ModelInfo[] = [
  { id: "gemini-3.1-flash-image-preview", display_name: "Gemini 3.1 Image", capability: "IMAGE" },
];

const VIDEO_MODELS: ModelInfo[] = [
  { id: "veo3.1-fast", display_name: "Veo 3.1 Fast", capability: "VIDEO" },
  { id: "veo3.1-4k", display_name: "Veo 3.1 (4K)", capability: "VIDEO" },
  { id: "veo3.1-pro-4k", display_name: "Veo 3.1 Pro (4K)", capability: "VIDEO" },
  { id: "doubao-seedance-2-0-v2-250528", display_name: "Seedance 2.0", capability: "VIDEO" },
  { id: "doubao-seedance-2-0-v2-250528-fast", display_name: "Seedance 2.0 Fast", capability: "VIDEO" },
];

const CAPABILITY_MAP: Record<string, ModelInfo[]> = {
  CHAT: CHAT_MODELS,
  IMAGE: IMAGE_MODELS,
  VIDEO: VIDEO_MODELS,
};

const ALL_MODELS: ModelInfo[] = [
  ...CHAT_MODELS,
  ...IMAGE_MODELS,
  ...VIDEO_MODELS,
];

export const modelService = {
  async getAll(): Promise<ModelInfo[]> {
    return ALL_MODELS;
  },

  async getByCapability(capability: string): Promise<ModelInfo[]> {
    return CAPABILITY_MAP[capability.toUpperCase()] ?? CHAT_MODELS;
  },

  async getChatModels(): Promise<ModelInfo[]> {
    return CHAT_MODELS;
  },

  async getImageModels(): Promise<ModelInfo[]> {
    return IMAGE_MODELS;
  },

  async getVideoModels(): Promise<ModelInfo[]> {
    return VIDEO_MODELS;
  },

  async getDefaultChatModel(): Promise<string> {
    return CHAT_MODELS[0]!.id;
  },

  async getDefaultImageModel(): Promise<string> {
    return IMAGE_MODELS[0]!.id;
  },

  async getDefaultVideoModel(): Promise<string> {
    return VIDEO_MODELS[0]!.id;
  },

  resolveImageModelId(baseId: string, resolution: string): string {
    if (baseId.startsWith("gemini-3.1-flash-image-preview")) {
      return resolution === "4K"
        ? "gemini-3.1-flash-image-preview-4k"
        : "gemini-3.1-flash-image-preview-2k";
    }
    return baseId;
  },

  invalidateCache() {},
};
