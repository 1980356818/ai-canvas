import { create } from "zustand";
import type { AgentMessage, AgentStatus } from "@/agent/types";
import { ToolRegistry } from "@/agent/tools/registry";
import { ProviderManager } from "@/agent/providers/manager";
import { OpenAIProvider } from "@/agent/providers/openai";
import { registerAllTools } from "@/agent/plugins";
import { buildSystemPrompt } from "@/agent/prompts";
import { createAgentContext } from "@/agent/context";
import { runAgent } from "@/agent/runtime";
import { modelService } from "@/services/models";

// ── Singleton instances ─────────────────────────────────────

const providerManager = new ProviderManager();
providerManager.register(new OpenAIProvider());

const toolRegistry = new ToolRegistry();
registerAllTools(toolRegistry);

// ── Store ───────────────────────────────────────────────────

interface AgentState {
  messages: AgentMessage[];
  status: AgentStatus;
  sessionId: string;
  error: string | null;

  sendMessage: (
    projectId: string,
    content: AgentMessage["content"],
    model?: string,
  ) => Promise<void>;
  clearSession: () => void;
  setError: (error: string | null) => void;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  messages: [],
  status: "idle",
  sessionId: crypto.randomUUID(),
  error: null,

  async sendMessage(projectId, content, model) {
    const userMsg: AgentMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      timestamp: Date.now(),
    };

    set((s) => ({
      messages: [...s.messages, userMsg],
      status: "thinking" as const,
      error: null,
    }));

    const allMessages = [...get().messages];
    const resolvedModel = model ?? (await modelService.getDefaultChatModel());

    const ctx = createAgentContext(
      projectId,
      get().sessionId,
      resolvedModel,
      providerManager,
    );

    const systemPrompt = buildSystemPrompt(
      toolRegistry.listTools() as Parameters<typeof buildSystemPrompt>[0],
    );

    try {
      const provider = providerManager.getDefault();

      await runAgent(provider, systemPrompt, allMessages, toolRegistry, ctx, {
        onMessage(msg) {
          set((s) => ({ messages: [...s.messages, msg] }));
        },
        onStatusChange(status) {
          set({ status });
        },
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      set({ status: "error", error: errorMsg });
    }
  },

  clearSession() {
    set({
      messages: [],
      status: "idle",
      sessionId: crypto.randomUUID(),
      error: null,
    });
  },

  setError(error) {
    set({ error, status: error ? "error" : "idle" });
  },
}));

export { providerManager, toolRegistry };
