import { OpenAICompatProvider } from "../openai-compat";
import { ALL_JIJING_MODELS, resolveJiJingImageModelId } from "./models";
import type { ModelInfo } from "@/types";

export class JiJingProvider extends OpenAICompatProvider {
  readonly descriptor = {
    id: "jijing" as const,
    name: "极境",
    capabilities: ["chat", "vision", "tool_calling", "image_gen", "streaming"] as const,
    configSchema: [
      { key: "apiKey", label: "API Key", type: "password" as const, required: true },
      {
        key: "baseUrl",
        label: "Base URL",
        type: "url" as const,
        required: false,
        default: "https://ai.snoworangekeji.cn",
      },
    ],
  };

  protected staticModels(): ModelInfo[] {
    return ALL_JIJING_MODELS;
  }

  protected defaultImageModel(): string {
    return "nano-banana-2";
  }

  protected imageRefField(): string {
    return "images";
  }

  resolveImageModelId(baseId: string, resolution: string): string {
    return resolveJiJingImageModelId(baseId, resolution);
  }
}
