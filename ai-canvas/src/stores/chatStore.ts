import { create } from "zustand";
import {
  listChatSessions,
  createChatSession,
  renameChatSession,
  deleteChatSession,
  loadChatMessages,
  saveChatMessage,
  clearChatMessages,
  type ChatSessionRow,
  type ChatMessageRow,
} from "@/lib/tauri";
import {
  type ChatContentPart,
  type Intent,
  parseIntent,
  chatCompletion,
  generateImage,
  generateVideo,
  generateTitle,
  extractSizeFromPrompt,
} from "@/lib/chatService";
import { modelService } from "@/services/models";

export type { ChatSession, ChatMessage } from "@/types";
import type { ChatSession, ChatMessage } from "@/types";

// ── Store ───────────────────────────────────────────────────

interface ChatState {
  sessions: ChatSession[];
  currentSessionId: string | null;
  messages: ChatMessage[];

  generating: boolean;
  generatingType: Intent | null;
  generatingProgress: number;
  generatingStatus: string;
  generatingStartedAt: number;
  streamingText: string;

  chatModel: string;
  imageModel: string;
  videoModel: string;

  loadSessions: () => Promise<void>;
  createSession: () => Promise<string>;
  switchSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;

  sendMessage: (text: string, imageUrls?: string[], videoUrls?: string[]) => Promise<void>;
  stopGenerating: () => void;
  clearMessages: () => Promise<void>;
}

function rowToSession(r: ChatSessionRow): ChatSession {
  return {
    id: r.id,
    projectId: r.project_id ?? undefined,
    title: r.title === "New Chat" ? "新对话" : r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToMessage(r: ChatMessageRow): ChatMessage {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role as ChatMessage["role"],
    content: JSON.parse(r.content),
    metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    createdAt: r.created_at,
  };
}

function messageToRow(m: ChatMessage): ChatMessageRow {
  return {
    id: m.id,
    session_id: m.sessionId,
    role: m.role,
    content: JSON.stringify(m.content),
    metadata: m.metadata ? JSON.stringify(m.metadata) : null,
    created_at: m.createdAt,
  };
}

let _abortController: AbortController | null = null;

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  messages: [],

  generating: false,
  generatingType: null,
  generatingProgress: 0,
  generatingStatus: "",
  generatingStartedAt: 0,
  streamingText: "",

  chatModel: "",
  imageModel: "",
  videoModel: "",

  async loadSessions() {
    const rows = await listChatSessions();
    const sessions = rows.map(rowToSession);
    set({ sessions });

    let sid = get().currentSessionId;

    if (!sid && sessions.length > 0) {
      sid = sessions[0]!.id;
      set({ currentSessionId: sid });
    }

    if (sid && get().messages.length === 0) {
      const msgRows = await loadChatMessages(sid);
      set({ messages: msgRows.map(rowToMessage) });
    }

    if (!get().chatModel) {
      const chat = await modelService.getDefaultChatModel();
      const image = await modelService.getDefaultImageModel();
      const video = await modelService.getDefaultVideoModel();
      set({ chatModel: chat, imageModel: image, videoModel: video });
    }
  },

  async createSession() {
    const id = crypto.randomUUID();
    const row = await createChatSession(id, "新对话");
    const session = rowToSession(row);
    set((s) => ({
      sessions: [session, ...s.sessions],
      currentSessionId: id,
      messages: [],
      streamingText: "",
    }));
    return id;
  },

  async switchSession(id) {
    const rows = await loadChatMessages(id);
    set({
      currentSessionId: id,
      messages: rows.map(rowToMessage),
      streamingText: "",
    });
  },

  async deleteSession(id) {
    await deleteChatSession(id);
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id);
      const isCurrent = s.currentSessionId === id;
      return {
        sessions,
        currentSessionId: isCurrent
          ? sessions[0]?.id ?? null
          : s.currentSessionId,
        messages: isCurrent
          ? []
          : s.messages,
        streamingText: isCurrent ? "" : s.streamingText,
      };
    });

    const state = get();
    if (state.currentSessionId && state.currentSessionId !== id) {
      const rows = await loadChatMessages(state.currentSessionId);
      set({ messages: rows.map(rowToMessage) });
    }
  },

  async renameSession(id, title) {
    await renameChatSession(id, title);
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, title } : x,
      ),
    }));
  },

  async sendMessage(text, imageUrls, videoUrls) {
    const state = get();
    if (state.generating) return;

    const hasImages = imageUrls && imageUrls.length > 0;
    const hasVideos = videoUrls && videoUrls.length > 0;
    const hasMedia = hasImages || hasVideos;
    const parsed = parseIntent(text);
    const intent = hasMedia ? "chat" as Intent : parsed.intent;
    const prompt = parsed.prompt;
    if (!prompt && !hasMedia) return;

    if (!state.chatModel || !state.imageModel || !state.videoModel) {
      const [chat, image, video] = await Promise.all([
        state.chatModel ? Promise.resolve(state.chatModel) : modelService.getDefaultChatModel(),
        state.imageModel ? Promise.resolve(state.imageModel) : modelService.getDefaultImageModel(),
        state.videoModel ? Promise.resolve(state.videoModel) : modelService.getDefaultVideoModel(),
      ]);
      set({ chatModel: chat, imageModel: image, videoModel: video });
    }

    set({
      generating: true,
      generatingType: intent,
      generatingProgress: 0,
      generatingStatus: "",
      generatingStartedAt: Date.now(),
      streamingText: "",
    });

    let sessionId = state.currentSessionId;
    if (!sessionId) {
      sessionId = await get().createSession();
    }

    const userContent: ChatContentPart[] = [];
    if (text) userContent.push({ type: "text", text });
    if (hasImages) {
      for (const url of imageUrls) {
        userContent.push({ type: "image", url });
      }
    }
    if (hasVideos) {
      for (const url of videoUrls) {
        userContent.push({ type: "video", url });
      }
    }

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      sessionId,
      role: "user",
      content: userContent,
      metadata: { intent },
      createdAt: new Date().toISOString(),
    };

    set((s) => ({
      messages: [...s.messages, userMsg],
    }));

    await saveChatMessage(messageToRow(userMsg));

    const isFirstMessage = get().messages.length === 1;

    _abortController = new AbortController();

    try {
      let resultParts: ChatContentPart[];

      const handleProgress = (progress: number, status: string) => {
        set({ generatingProgress: progress, generatingStatus: status });
      };

      const currentState = get();

      if (intent === "image") {
        const { cleanPrompt, size } = extractSizeFromPrompt(prompt);
        const result = await generateImage(cleanPrompt, currentState.imageModel || undefined, handleProgress, size);
        resultParts = [{ type: "image", url: result.url, prompt: cleanPrompt }];
      } else if (intent === "video") {
        const result = await generateVideo(prompt, currentState.videoModel || undefined, handleProgress);
        resultParts = [{ type: "video", url: result.url, prompt }];
      } else {
        const history = get().messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));
        resultParts = await chatCompletion(
          history,
          currentState.chatModel,
          {
            onStreamChunk(chunk) {
              set((s) => ({ streamingText: s.streamingText + chunk }));
            },
            onStreamDone() {
              set({ streamingText: "" });
            },
            onMediaGenerating(mediaType) {
              set({ generatingType: mediaType, generatingProgress: 0, generatingStatus: "" });
            },
            onMediaProgress: handleProgress,
          },
        );
      }

      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        sessionId,
        role: "assistant",
        content: resultParts,
        metadata: {
          model:
            intent === "image"
              ? get().imageModel
              : intent === "video"
                ? get().videoModel
                : get().chatModel,
          intent,
        },
        createdAt: new Date().toISOString(),
      };

      set((s) => ({
        messages: [...s.messages, assistantMsg],
        generating: false,
        generatingType: null,
        generatingProgress: 0,
        generatingStatus: "",
        generatingStartedAt: 0,
        streamingText: "",
      }));

      await saveChatMessage(messageToRow(assistantMsg));

      if (isFirstMessage && sessionId) {
        const firstText = text.slice(0, 200);
        const titleModel = get().chatModel;
        if (titleModel) {
          generateTitle(firstText, titleModel).then((title) => {
            if (title && title !== "新对话") {
              get().renameSession(sessionId, title);
            }
          }).catch(() => {});
        }
      }
    } catch (e) {
      const errorText =
        e instanceof Error ? e.message : String(e);

      const errorMsg: ChatMessage = {
        id: crypto.randomUUID(),
        sessionId,
        role: "assistant",
        content: [{ type: "text", text: `Error: ${errorText}` }],
        createdAt: new Date().toISOString(),
      };

      set((s) => ({
        messages: [...s.messages, errorMsg],
        generating: false,
        generatingType: null,
        generatingProgress: 0,
        generatingStatus: "",
        generatingStartedAt: 0,
        streamingText: "",
      }));

      await saveChatMessage(messageToRow(errorMsg));
    }

    _abortController = null;
  },

  stopGenerating() {
    _abortController?.abort();
    set({ generating: false, generatingType: null, generatingProgress: 0, generatingStatus: "", generatingStartedAt: 0, streamingText: "" });
  },

  async clearMessages() {
    const sid = get().currentSessionId;
    if (!sid) return;
    await clearChatMessages(sid);
    set({ messages: [], streamingText: "" });
  },

}));
