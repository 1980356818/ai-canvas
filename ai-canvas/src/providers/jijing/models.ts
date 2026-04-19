import type { ModelInfo } from "@/types";

export const JIJING_CHAT_MODELS: ModelInfo[] = [
  { id: "gemini-3.1-pro-preview", display_name: "Gemini 3.1 Pro", capability: "CHAT" },
];

export const JIJING_IMAGE_MODELS: ModelInfo[] = [
  { id: "nano-banana-2", display_name: "Nanobanana 2", capability: "IMAGE" },
  { id: "nano-banana-pro", display_name: "Nanobanana Pro", capability: "IMAGE" },
  { id: "qwen-image-edit-2511-multipie", display_name: "Qwen 多角度", capability: "IMAGE" },
  { id: "Real-ESRGAN", display_name: "Real-ESRGAN 超分", capability: "IMAGE" },
  { id: "SeedVR2-Upscaler", display_name: "SeedVR2 高清放大", capability: "IMAGE" },
];

export const ALL_JIJING_MODELS: ModelInfo[] = [
  ...JIJING_CHAT_MODELS,
  ...JIJING_IMAGE_MODELS,
];

export function resolveJiJingImageModelId(baseId: string, resolution: string): string {
  if (baseId === "nano-banana-2") {
    return resolution === "4K" ? "nano-banana-2-4k" : "nano-banana-2";
  }
  if (baseId === "nano-banana-pro") {
    return resolution === "4K" ? "nano-banana-pro-4k" : "nano-banana-pro";
  }
  return baseId;
}
