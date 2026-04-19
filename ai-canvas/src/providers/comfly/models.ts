import type { ModelInfo } from "@/types";

export const COMFLY_CHAT_MODELS: ModelInfo[] = [
  { id: "gemini-3.1-pro-preview-thinking-high", display_name: "Gemini 3.1 Pro (Thinking)", capability: "CHAT" },
  { id: "gemini-3.1-pro-preview", display_name: "Gemini 3.1 Pro", capability: "CHAT" },
];

export const COMFLY_IMAGE_MODELS: ModelInfo[] = [
  { id: "gemini-3.1-flash-image-preview", display_name: "Nanobanana 2", capability: "IMAGE" },
  { id: "nano-banana-pro", display_name: "Nanobanana Pro", capability: "IMAGE" },
];

export const COMFLY_VIDEO_MODELS: ModelInfo[] = [
  { id: "veo3.1-fast", display_name: "Veo 3.1 Fast", capability: "VIDEO" },
  { id: "veo3.1-4k", display_name: "Veo 3.1 (4K)", capability: "VIDEO" },
  { id: "veo3.1-pro-4k", display_name: "Veo 3.1 Pro (4K)", capability: "VIDEO" },
];

export const ALL_COMFLY_MODELS: ModelInfo[] = [
  ...COMFLY_CHAT_MODELS,
  ...COMFLY_IMAGE_MODELS,
  ...COMFLY_VIDEO_MODELS,
];

export function resolveComflyImageModelId(baseId: string, resolution: string): string {
  if (baseId.startsWith("gemini-3.1-flash-image-preview")) {
    return resolution === "4K"
      ? "gemini-3.1-flash-image-preview-4k"
      : "gemini-3.1-flash-image-preview-2k";
  }
  if (baseId === "nano-banana-pro") {
    return resolution === "4K" ? "nano-banana-pro-4k" : "nano-banana-pro-2k";
  }
  return baseId;
}

const LEGACY_DISPLAY: Record<string, string> = {
  "doubao-seedance-2-0-v2-250528": "Seedance 2.0 (旧)",
  "doubao-seedance-2-0-v2-250528-fast": "Seedance 2.0 Fast (旧)",
  "doubao-seedance-2-0-fast-v2-250528": "Seedance 2.0 Fast (旧)",
};

export function getComflyDisplayName(modelId: string): string | undefined {
  const m = ALL_COMFLY_MODELS.find((m) => m.id === modelId);
  if (m) return m.display_name ?? m.id;
  return LEGACY_DISPLAY[modelId];
}
