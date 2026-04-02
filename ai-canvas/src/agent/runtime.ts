import type { AgentContext, AgentMessage, AgentStatus, ContentPart } from "./types";
import type { AIProvider, ChatRequestMessage } from "./providers/base";
import type { ToolRegistry } from "./tools/registry";

const MAX_TOOL_ROUNDS = 8;

export interface RuntimeCallbacks {
  onMessage: (msg: AgentMessage) => void;
  onStatusChange: (status: AgentStatus) => void;
}

function makeId(): string {
  return crypto.randomUUID();
}

function agentMessageToLLM(messages: AgentMessage[]): ChatRequestMessage[] {
  const out: ChatRequestMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      out.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      if (msg.toolCalls?.length) {
        out.push({
          role: "assistant",
          content: msg.content,
          toolCalls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          })),
        });
      } else {
        const text = msg.content
          .filter((p): p is ContentPart & { type: "text" } => p.type === "text")
          .map((p) => p.text)
          .join("\n");
        out.push({ role: "assistant", content: text });
      }
    } else if (msg.role === "tool" && msg.toolResult) {
      out.push({
        role: "tool",
        content: JSON.stringify(msg.toolResult.output),
        toolCallId: msg.toolResult.callId,
      });
    }
  }

  return out;
}

export async function runAgent(
  provider: AIProvider,
  systemPrompt: string,
  history: AgentMessage[],
  registry: ToolRegistry,
  ctx: AgentContext,
  callbacks: RuntimeCallbacks,
): Promise<void> {
  const llmMessages = agentMessageToLLM(history);
  const tools = registry.toFunctionSchemas();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    callbacks.onStatusChange("thinking");

    const response = await provider.chat({
      model: ctx.model,
      systemPrompt,
      messages: llmMessages,
      tools: tools.length > 0 ? tools : undefined,
    });

    if (response.finishReason === "stop" || response.toolCalls.length === 0) {
      const assistantMsg: AgentMessage = {
        id: makeId(),
        role: "assistant",
        content: response.content
          ? [{ type: "text", text: response.content }]
          : [],
        timestamp: Date.now(),
      };
      callbacks.onMessage(assistantMsg);
      callbacks.onStatusChange("idle");
      return;
    }

    const assistantMsg: AgentMessage = {
      id: makeId(),
      role: "assistant",
      content: response.content
        ? [{ type: "text", text: response.content }]
        : [],
      toolCalls: response.toolCalls,
      timestamp: Date.now(),
    };
    callbacks.onMessage(assistantMsg);

    llmMessages.push({
      role: "assistant",
      content: response.content ?? "",
      toolCalls: response.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
      })),
    });

    callbacks.onStatusChange("calling_tool");

    for (const call of response.toolCalls) {
      const result = await registry.execute(call.name, call.arguments, ctx);

      const toolMsg: AgentMessage = {
        id: makeId(),
        role: "tool",
        content: [
          {
            type: "text",
            text: result.success
              ? JSON.stringify(result.data)
              : `Error: ${JSON.stringify(result.data)}`,
          },
        ],
        toolResult: {
          callId: call.id,
          output: result.data,
          success: result.success,
        },
        timestamp: Date.now(),
      };
      callbacks.onMessage(toolMsg);

      llmMessages.push({
        role: "tool",
        content: JSON.stringify(result.data),
        toolCallId: call.id,
      });
    }
  }

  callbacks.onMessage({
    id: makeId(),
    role: "assistant",
    content: [
      { type: "text", text: "已达到最大执行轮次，请检查结果或补充说明。" },
    ],
    timestamp: Date.now(),
  });
  callbacks.onStatusChange("idle");
}
