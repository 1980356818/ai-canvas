import type {
  ChatRequest,
  ChatResponse,
  StreamEvent,
  UnifiedMessage,
  UnifiedContentPart,
} from "../types";
import type { AiProxyResponse } from "@/types";

// ── Normalize legacy agent / tool payloads → UnifiedMessage ──

type LooseContentPart = {
  type: string;
  text?: string;
  url?: string;
  name?: string;
  path?: string;
};

type LooseMessage = {
  role: string;
  content: string | LooseContentPart[];
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  toolCallId?: string;
};

/** Accepts runtime / tool legacy shapes (string content, extra fields on image parts). */
export function normalizeIncomingChatRequest(req: ChatRequest): ChatRequest {
  const loose = req.messages as unknown as LooseMessage[];
  const messages: UnifiedMessage[] = loose.map((msg) => {
    let parts: UnifiedContentPart[];
    const c = msg.content;
    if (typeof c === "string") {
      parts = [{ type: "text", text: c }];
    } else if (Array.isArray(c)) {
      parts = c.map((p): UnifiedContentPart => {
        if (!p || typeof p !== "object") return { type: "text", text: "" };
        if (p.type === "text") return { type: "text", text: p.text ?? "" };
        if (p.type === "image") return { type: "image", url: p.url ?? "" };
        if (p.type === "video") return { type: "video", url: p.url ?? "" };
        if (p.type === "file")
          return { type: "file", name: p.name ?? "file", url: p.path ?? p.url ?? "" };
        return { type: "text", text: "" };
      });
    } else {
      parts = [{ type: "text", text: String(c) }];
    }
    return {
      role: msg.role as UnifiedMessage["role"],
      content: parts,
      toolCalls: msg.toolCalls,
      toolCallId: msg.toolCallId,
    };
  });
  return { ...req, messages };
}

// ── Message formatting (Unified → OpenAI) ───────────────────

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function formatContentParts(parts: UnifiedContentPart[]): string | OpenAIContentPart[] {
  if (parts.length === 1 && parts[0]!.type === "text") {
    return parts[0]!.text;
  }
  return parts.map((p): OpenAIContentPart => {
    switch (p.type) {
      case "text":
        return { type: "text", text: p.text };
      case "image":
      case "video":
        return { type: "image_url", image_url: { url: p.url } };
      case "file":
        return { type: "text", text: `[file: ${p.name}]` };
    }
  });
}

export function formatMessagesForOpenAI(
  req: ChatRequest,
): Array<Record<string, unknown>> {
  const normalized = normalizeIncomingChatRequest(req);
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: normalized.systemPrompt },
  ];

  for (const msg of normalized.messages) {
    if (msg.role === "system") continue;

    if (msg.role === "assistant" && msg.toolCalls?.length) {
      messages.push({
        role: "assistant",
        content: msg.content.length > 0 ? formatContentParts(msg.content) : null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });
    } else if (msg.role === "tool" && msg.toolCallId) {
      const text = msg.content.length > 0 && msg.content[0]!.type === "text"
        ? msg.content[0]!.text
        : JSON.stringify(msg.content);
      messages.push({
        role: "tool",
        tool_call_id: msg.toolCallId,
        content: text,
      });
    } else {
      messages.push({
        role: msg.role,
        content: formatContentParts(msg.content),
      });
    }
  }

  return messages;
}

// ── Stream chunk parsing ────────────────────────────────────

interface ToolCallAccumulator {
  [index: number]: { id: string; name: string; arguments: string };
}

let _tcAccum: ToolCallAccumulator = {};

export function resetStreamState(): void {
  _tcAccum = {};
}

export function parseOpenAIStreamChunk(
  raw: string,
  emit: (event: StreamEvent) => void,
): void {
  try {
    const parsed = JSON.parse(raw);
    const delta = parsed.choices?.[0]?.delta;
    if (!delta) return;

    if (delta.content) {
      emit({ type: "text", text: delta.content });
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!_tcAccum[idx]) {
          _tcAccum[idx] = { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" };
        }
        if (tc.id) _tcAccum[idx]!.id = tc.id;
        if (tc.function?.name) {
          _tcAccum[idx]!.name = tc.function.name;
          emit({ type: "tool_call_start", id: _tcAccum[idx]!.id, name: tc.function.name });
        }
        if (tc.function?.arguments) {
          _tcAccum[idx]!.arguments += tc.function.arguments;
          emit({ type: "tool_call_delta", id: _tcAccum[idx]!.id, arguments: tc.function.arguments });
        }
      }
    }
  } catch {
    // skip malformed chunks
  }
}

export function getAccumulatedToolCalls(): Array<{ id: string; name: string; arguments: string }> {
  return Object.values(_tcAccum);
}

// ── Non-streaming response parsing ──────────────────────────

export function parseOpenAIChatResponse(raw: AiProxyResponse): ChatResponse {
  const data = JSON.parse(raw.body);
  const choice = data.choices?.[0];
  if (!choice) throw new Error("No response from model");

  const toolCalls = (choice.message.tool_calls ?? []).map(
    (tc: { id: string; function: { name: string; arguments: string } }) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    }),
  );

  return {
    content: choice.message.content ?? null,
    toolCalls,
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    },
    finishReason:
      choice.finish_reason === "tool_calls" ? "tool_calls" : "stop",
  };
}

// ── Helpers for ChatHistoryMessage → UnifiedMessage ─────────

export function chatHistoryToUnified(
  history: Array<{ role: string; content: Array<{ type: string; text?: string; url?: string; prompt?: string }> }>,
): UnifiedMessage[] {
  return history.map((msg) => ({
    role: msg.role as UnifiedMessage["role"],
    content: msg.content
      .filter((p) => p.type !== "loading")
      .map((p): UnifiedContentPart => {
        if (p.type === "text") return { type: "text", text: p.text ?? "" };
        if (p.type === "image") return { type: "image", url: p.url ?? "" };
        if (p.type === "video") return { type: "video", url: p.url ?? "" };
        return { type: "text", text: "" };
      }),
  }));
}
