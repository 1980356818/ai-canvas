import { OpenAICompatProvider } from "../openai-compat";
import { ALL_COMFLY_MODELS, resolveComflyImageModelId, getComflyDisplayName } from "./models";
import type { ModelInfo } from "@/types";

export class ComflyProvider extends OpenAICompatProvider {
  readonly descriptor = {
    id: "comfly" as const,
    name: "Comfly",
    capabilities: ["chat", "vision", "tool_calling", "image_gen", "video_gen", "streaming"] as const,
    configSchema: [
      { key: "apiKey", label: "API Key", type: "password" as const, required: true },
      {
        key: "baseUrl",
        label: "Base URL",
        type: "url" as const,
        required: false,
        default: "https://ai.comfly.chat",
      },
    ],
  };

  protected staticModels(): ModelInfo[] {
    return ALL_COMFLY_MODELS;
  }

  resolveImageModelId(baseId: string, resolution: string): string {
    return resolveComflyImageModelId(baseId, resolution);
  }

  getDisplayName(modelId: string): string | undefined {
    return getComflyDisplayName(modelId);
  }
}
