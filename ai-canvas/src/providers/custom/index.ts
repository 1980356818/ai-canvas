import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  StreamEvent,
  ProviderConfig,
  ImageGenRequest,
  ImageGenResponse,
  VideoGenRequest,
  VideoGenResponse,
} from "../types";
import { throwIfError } from "../errors";
import {
  formatMessagesForOpenAI,
  parseOpenAIChatResponse,
  parseOpenAIStreamChunk,
  resetStreamState,
  getAccumulatedToolCalls,
} from "../openai/formatter";
import { aiProxy, aiProxyStream, listModels as platformListModels } from "@/platform";
import type { ModelInfo } from "@/types";

export class CustomProvider implements AIProvider {
  private _id: string;
  private _name: string;
  private _baseUrl: string;
  private _apiKey: string;
  private _models: ModelInfo[];

  constructor(
    id: string,
    name: string,
    baseUrl: string = "",
    apiKey: string = "",
    models: ModelInfo[] = [],
  ) {
    this._id = id;
    this._name = name;
    this._baseUrl = baseUrl;
    this._apiKey = apiKey;
    this._models = models;
  }

  get descriptor() {
    return {
      id: this._id,
      name: this._name,
      capabilities: ["chat", "vision", "tool_calling", "image_gen", "video_gen", "streaming"] as const,
      configSchema: [
        { key: "apiKey", label: "API Key", type: "password" as const, required: true },
        { key: "baseUrl", label: "Base URL", type: "url" as const, required: true, placeholder: "https://api.example.com" },
      ],
    };
  }

  initialize(config: ProviderConfig): void {
    this._baseUrl = config.baseUrl;
    this._apiKey = config.apiKey;
  }

  setModels(models: ModelInfo[]): void {
    this._models = models;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this._models.length > 0) return this._models;

    try {
      const raw = await platformListModels();
      return raw.map((m) => ({
        id: m.id,
        display_name: m.display_name ?? m.id,
        capability: m.capability ?? "CHAT",
      }));
    } catch {
      return [];
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const messages = formatMessagesForOpenAI(req);
    const body: Record<string, unknown> = { model: req.model, messages };
    if (req.tools?.length) body.tools = req.tools;
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.temperature != null) body.temperature = req.temperature;

    const raw = await aiProxy(this._id, "/v1/chat/completions", body);
    throwIfError(raw.status, raw.body);
    return parseOpenAIChatResponse(raw);
  }

  async streamChat(
    req: ChatRequest,
    onEvent: (event: StreamEvent) => void,
  ): Promise<{ abort: () => void }> {
    resetStreamState();

    const messages = formatMessagesForOpenAI(req);
    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      stream: true,
    };
    if (req.tools?.length) body.tools = req.tools;
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.temperature != null) body.temperature = req.temperature;

    const { abort } = await aiProxyStream(
      this._id,
      "/v1/chat/completions",
      body,
      {
        onChunk: (raw) => parseOpenAIStreamChunk(raw, onEvent),
        onDone: () => {
          const tcs = getAccumulatedToolCalls();
          for (const tc of tcs) {
            onEvent({ type: "tool_call_end", id: tc.id });
          }
          onEvent({ type: "done" });
        },
        onError: (e) => onEvent({ type: "error", message: e }),
      },
    );

    return { abort };
  }

  async generateImage(req: ImageGenRequest): Promise<ImageGenResponse> {
    const body: Record<string, unknown> = {
      model: req.model ?? "dall-e-3",
      prompt: req.prompt,
      size: req.size || "1024x1024",
      quality: req.quality || "standard",
      n: 1,
      response_format: "url",
    };

    const raw = await aiProxy(this._id, "/v1/images/generations", body);
    throwIfError(raw.status, raw.body);

    const data = JSON.parse(raw.body);
    const img = data.data?.[0];
    if (!img?.url) throw new Error("No image returned");
    return { url: img.url, revisedPrompt: img.revised_prompt };
  }

  async generateVideo(req: VideoGenRequest): Promise<VideoGenResponse> {
    const body: Record<string, unknown> = {
      model: req.model ?? "video-gen-1",
      prompt: req.prompt,
    };
    if (req.size) body.size = req.size;

    const raw = await aiProxy(this._id, "/v2/videos/generations", body);
    throwIfError(raw.status, raw.body);

    const data = JSON.parse(raw.body);
    const video = data.data?.[0];
    if (!video?.url) throw new Error("No video returned");
    return { url: video.url };
  }
}
