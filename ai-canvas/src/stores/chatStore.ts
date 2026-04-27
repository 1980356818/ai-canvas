import { create } from "zustand";
import {
  listChatSessions,
  createChatSession,
  renameChatSession,
  deleteChatSession,
  loadChatMessages,
  saveChatMessage,
  clearChatMessages,
} from "@/platform";
import type { ChatSessionRow, ChatMessageRow, ChatHistoryMessage } from "@/types";
import {
  type ChatContentPart,
  type Intent,
  parseIntent,
  generateTitle,
  extractSizeFromPrompt,
} from "@/lib/chatService";
import { modelService } from "@/services/models";
import { providerService } from "@/services/provider.service";
import { useProviderStore, parseModelRef } from "@/stores/providerStore";
import { getAccumulatedToolCalls } from "@/providers/openai-compat/formatter";
import { getBase64ForApi } from "@/lib/media";
import { getAllowedSizesForModel, coerceToAllowedSize } from "@/shared/constants";
import type { StreamEvent, UnifiedMessage, UnifiedContentPart } from "@/providers/types";

export type { ChatSession, ChatMessage } from "@/types";
import type { ChatSession, ChatMessage } from "@/types";

const CHAT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "generate_image",
      description:
        "When the user asks to generate, draw, create, or design an image/picture/illustration, call this function.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Detailed English prompt for image generation",
          },
          size: {
            type: "string",
            description: "Image aspect ratio",
            enum: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
          },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "generate_video",
      description:
        "When the user asks to generate, create, or make a video/animation/clip, call this function.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Detailed English prompt for video generation",
          },
        },
        required: ["prompt"],
      },
    },
  },
];

// 根据当前对话模型推导出对应的图片模型 ref：
//  - GPT 系列 → gpt-image-2（同 provider 优先）
//  - Gemini 系列 → nanobanana 2（jijing 用 nano-banana-2，否则 comfly 的 gemini-3.1-flash-image-preview）
//  - 其他 → 沿用 activeImageRef
function pickImageModelRefForChat(chatProviderId: string, chatModelId: string): string {
  const id = (chatModelId || "").toLowerCase();
  if (id.includes("gpt")) {
    return `${chatProviderId}:gpt-image-2`;
  }
  if (id.includes("gemini")) {
    if (chatProviderId === "jijing") return "jijing:nano-banana-2";
    return "comfly:gemini-3.1-flash-image-preview";
  }
  return useProviderStore.getState().activeImageRef;
}

async function historyToUnified(history: ChatHistoryMessage[]): Promise<UnifiedMessage[]> {
  const result: UnifiedMessage[] = [];
  for (const msg of history) {
    const parts: UnifiedContentPart[] = [];
    for (const p of msg.content) {
      if (p.type === "loading" || p.type === "image_pending" || p.type === "video_pending") continue;
      if (p.type === "text") {
        parts.push({ type: "text", text: p.text });
      } else if (p.type === "image") {
        const url = await getBase64ForApi(p.url);
        parts.push({ type: "image", url });
      } else if (p.type === "video") {
        const url = p.url ? await getBase64ForApi(p.url) : "";
        parts.push({ type: "video", url });
      }
    }
    result.push({ role: msg.role as UnifiedMessage["role"], content: parts });
  }
  return result;
}

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
  confirmImageGeneration: (messageId: string, partIndex: number, prompt: string, modelRef: string, size: string) => Promise<void>;
  confirmVideoGeneration: (messageId: string, partIndex: number, prompt: string, modelRef: string) => Promise<void>;
  updatePendingPrompt: (messageId: string, partIndex: number, prompt: string) => void;
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
      const [chat, image, video] = await Promise.all([
        modelService.getDefaultChatModel(),
        modelService.getDefaultImageModel(),
        modelService.getDefaultVideoModel(),
      ]);
      set({ chatModel: chat.modelId, imageModel: image.modelId, videoModel: video.modelId });
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
      const [chatRef, imageRef, videoRef] = await Promise.all([
        state.chatModel ? null : modelService.getDefaultChatModel(),
        state.imageModel ? null : modelService.getDefaultImageModel(),
        state.videoModel ? null : modelService.getDefaultVideoModel(),
      ]);
      set({
        chatModel: chatRef?.modelId ?? state.chatModel,
        imageModel: imageRef?.modelId ?? state.imageModel,
        videoModel: videoRef?.modelId ?? state.videoModel,
      });
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
      if (intent === "image") {
        // /image：直接根据当前对话模型选择对应图片模型并出图，不再生成确认卡片
        const { cleanPrompt, size } = extractSizeFromPrompt(prompt);
        const chatRef = useProviderStore.getState().activeChatRef;
        const { providerId: chatProvId, modelId: chatModId } = parseModelRef(chatRef);
        const imageRef = pickImageModelRefForChat(chatProvId, chatModId);
        const { providerId: imgProvId, modelId: imgModId } = parseModelRef(imageRef);
        useProviderStore.getState().setActiveRef("image", imageRef);

        const allowedSizes = getAllowedSizesForModel(imgModId);
        const finalSize = coerceToAllowedSize(size || "1:1", allowedSizes);

        const assistantId = crypto.randomUUID();
        const placeholder: ChatMessage = {
          id: assistantId,
          sessionId,
          role: "assistant",
          content: [{ type: "loading", mediaType: "image" }],
          metadata: { intent: "image", model: imgModId },
          createdAt: new Date().toISOString(),
        };
        set((s) => ({ messages: [...s.messages, placeholder] }));

        try {
          const result = await providerService.generateImage(imgProvId, {
            prompt: cleanPrompt,
            model: imgModId,
            size: finalSize,
            onProgress: (p) =>
              set({ generatingProgress: p.percent, generatingStatus: p.label }),
            signal: _abortController!.signal,
          });
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: [
                      { type: "image", url: result.url, prompt: cleanPrompt },
                    ],
                  }
                : m,
            ),
          }));
        } catch (e) {
          const errorText = e instanceof Error ? e.message : String(e);
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: [
                      { type: "text", text: `图片生成失败: ${errorText}` },
                    ],
                  }
                : m,
            ),
          }));
        }

        set({
          generating: false,
          generatingType: null,
          generatingProgress: 0,
          generatingStatus: "",
          generatingStartedAt: 0,
          streamingText: "",
        });
        const finalMsg = get().messages.find((m) => m.id === assistantId);
        if (finalMsg) await saveChatMessage(messageToRow(finalMsg));
      } else if (intent === "video") {
        // 视频暂保留确认卡片（本次仅改造图片生成）
        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          sessionId,
          role: "assistant",
          content: [{ type: "video_pending", prompt }],
          metadata: {
            model: parseModelRef(useProviderStore.getState().activeVideoRef).modelId,
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
      } else {
        // 普通对话：流式获取，遇到 generate_image tool_call 直接出图
        const history: ChatHistoryMessage[] = get().messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));
        const { providerId, modelId } = parseModelRef(
          useProviderStore.getState().activeChatRef,
        );

        let fullText = "";
        const unifiedMessages = await historyToUnified(history);
        const streamResult = await new Promise<{
          textParts: ChatContentPart[];
          imageJobs: { prompt: string; size?: string }[];
          videoJobs: { prompt: string }[];
        }>((resolve, reject) => {
          const ac = _abortController!;
          let settled = false;
          const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            ac.signal.removeEventListener("abort", onAbort);
            fn();
          };
          const onAbort = () => {
            settle(() => reject(new Error("Generation stopped")));
          };
          ac.signal.addEventListener("abort", onAbort, { once: true });

          void providerService
            .streamChat(
              providerId,
              {
                model: modelId,
                systemPrompt:
                  "You are a helpful AI assistant. You can have conversations, and when the user asks you to generate images or videos, use the provided tools. Always respond in the user's language.",
                messages: unifiedMessages,
                tools: CHAT_TOOLS,
                signal: ac.signal,
              },
              (event: StreamEvent) => {
                if (import.meta.env.DEV) {
                  console.debug("[chatStore] stream event:", event.type, event.type === "text" ? event.text.slice(0, 50) : event);
                }
                switch (event.type) {
                  case "text":
                    fullText += event.text;
                    set((s) => ({
                      streamingText: s.streamingText + event.text,
                    }));
                    break;
                  case "error":
                    settle(() => reject(new Error(event.message)));
                    break;
                  case "done": {
                    const textParts: ChatContentPart[] = [];
                    if (fullText) textParts.push({ type: "text", text: fullText });

                    const imageJobs: { prompt: string; size?: string }[] = [];
                    const videoJobs: { prompt: string }[] = [];
                    const toolCalls = getAccumulatedToolCalls();
                    for (const tc of toolCalls) {
                      try {
                        const args = JSON.parse(tc.arguments || "{}");
                        if (tc.name === "generate_image") {
                          imageJobs.push({
                            prompt: String(args.prompt ?? ""),
                            size: args.size as string | undefined,
                          });
                        } else if (tc.name === "generate_video") {
                          videoJobs.push({ prompt: String(args.prompt ?? "") });
                        }
                      } catch (e) {
                        textParts.push({
                          type: "text",
                          text: `\n\n> Generation failed: ${e instanceof Error ? e.message : String(e)}`,
                        });
                      }
                    }
                    if (
                      textParts.length === 0 &&
                      imageJobs.length === 0 &&
                      videoJobs.length === 0
                    ) {
                      textParts.push({
                        type: "text",
                        text: "（模型未返回有效内容，请尝试重新发送或切换模型）",
                      });
                    }
                    set({ streamingText: "" });
                    settle(() => resolve({ textParts, imageJobs, videoJobs }));
                    break;
                  }
                  default:
                    break;
                }
              },
            )
            .catch((e) => settle(() => reject(e instanceof Error ? e : new Error(String(e)))));
        });

        const initialContent: ChatContentPart[] = [...streamResult.textParts];
        const imageLoadingIndices: number[] = [];
        for (let i = 0; i < streamResult.imageJobs.length; i++) {
          imageLoadingIndices.push(initialContent.length);
          initialContent.push({ type: "loading", mediaType: "image" });
        }
        for (const job of streamResult.videoJobs) {
          initialContent.push({ type: "video_pending", prompt: job.prompt });
        }

        const assistantId = crypto.randomUUID();
        const assistantMsg: ChatMessage = {
          id: assistantId,
          sessionId,
          role: "assistant",
          content: initialContent,
          metadata: {
            model: parseModelRef(useProviderStore.getState().activeChatRef).modelId,
            intent,
          },
          createdAt: new Date().toISOString(),
        };
        set((s) => ({ messages: [...s.messages, assistantMsg] }));

        if (streamResult.imageJobs.length === 0) {
          set({
            generating: false,
            generatingType: null,
            generatingProgress: 0,
            generatingStatus: "",
            generatingStartedAt: 0,
            streamingText: "",
          });
          await saveChatMessage(messageToRow(assistantMsg));
        } else {
          set({
            generatingType: "image",
            generatingProgress: 0,
            generatingStatus: "",
            generatingStartedAt: Date.now(),
            streamingText: "",
          });

          const chatRef = useProviderStore.getState().activeChatRef;
          const { providerId: chatProvId, modelId: chatModId } = parseModelRef(chatRef);
          const imageRef = pickImageModelRefForChat(chatProvId, chatModId);
          const { providerId: imgProvId, modelId: imgModId } = parseModelRef(imageRef);
          useProviderStore.getState().setActiveRef("image", imageRef);
          const allowedSizes = getAllowedSizesForModel(imgModId);

          for (let i = 0; i < streamResult.imageJobs.length; i++) {
            const job = streamResult.imageJobs[i]!;
            const partIdx = imageLoadingIndices[i]!;
            const finalSize = coerceToAllowedSize(job.size || "1:1", allowedSizes);
            try {
              const result = await providerService.generateImage(imgProvId, {
                prompt: job.prompt,
                model: imgModId,
                size: finalSize,
                onProgress: (p) =>
                  set({ generatingProgress: p.percent, generatingStatus: p.label }),
                signal: _abortController!.signal,
              });
              set((s) => ({
                messages: s.messages.map((m) => {
                  if (m.id !== assistantId) return m;
                  const newContent = [...m.content];
                  newContent[partIdx] = {
                    type: "image",
                    url: result.url,
                    prompt: job.prompt,
                  };
                  return { ...m, content: newContent };
                }),
              }));
            } catch (e) {
              const errorText = e instanceof Error ? e.message : String(e);
              set((s) => ({
                messages: s.messages.map((m) => {
                  if (m.id !== assistantId) return m;
                  const newContent = [...m.content];
                  newContent[partIdx] = {
                    type: "text",
                    text: `\n图片生成失败: ${errorText}`,
                  };
                  return { ...m, content: newContent };
                }),
              }));
            }
          }

          set({
            generating: false,
            generatingType: null,
            generatingProgress: 0,
            generatingStatus: "",
            generatingStartedAt: 0,
          });
          const finalMsg = get().messages.find((m) => m.id === assistantId);
          if (finalMsg) await saveChatMessage(messageToRow(finalMsg));
        }
      }

      if (isFirstMessage && sessionId) {
        const firstText = text.slice(0, 200);
        const titleModel =
          get().chatModel ||
          parseModelRef(useProviderStore.getState().activeChatRef).modelId;
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

  async confirmImageGeneration(messageId, partIndex, prompt, modelRef, size) {
    if (get().generating) return;

    set({
      generating: true,
      generatingType: "image",
      generatingProgress: 0,
      generatingStatus: "",
      generatingStartedAt: Date.now(),
    });

    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== messageId) return m;
        const newContent = [...m.content];
        newContent[partIndex] = { type: "loading", mediaType: "image" as const };
        return { ...m, content: newContent };
      }),
    }));

    _abortController = new AbortController();

    try {
      const { providerId, modelId } = parseModelRef(modelRef);
      const result = await providerService.generateImage(providerId, {
        prompt,
        model: modelId,
        size: size || undefined,
        onProgress: (p) =>
          set({ generatingProgress: p.percent, generatingStatus: p.label }),
        signal: _abortController!.signal,
      });

      set((s) => ({
        messages: s.messages.map((m) => {
          if (m.id !== messageId) return m;
          const newContent = [...m.content];
          newContent[partIndex] = { type: "image", url: result.url, prompt };
          return { ...m, content: newContent, metadata: { ...m.metadata, model: modelId, intent: "image" as const } };
        }),
        generating: false,
        generatingType: null,
        generatingProgress: 0,
        generatingStatus: "",
        generatingStartedAt: 0,
      }));

      const msg = get().messages.find((m) => m.id === messageId);
      if (msg) {
        await saveChatMessage(messageToRow(msg));
      }
    } catch (e) {
      const errorText = e instanceof Error ? e.message : String(e);
      set((s) => ({
        messages: s.messages.map((m) => {
          if (m.id !== messageId) return m;
          const newContent = [...m.content];
          newContent[partIndex] = { type: "image_pending", prompt, suggestedSize: size };
          return { ...m, content: newContent };
        }),
        generating: false,
        generatingType: null,
        generatingProgress: 0,
        generatingStatus: "",
        generatingStartedAt: 0,
      }));

      const msg = get().messages.find((m) => m.id === messageId);
      if (msg) await saveChatMessage(messageToRow(msg));

      const { addToast } = await import("@/stores/uiStore").then((m) => m.useUIStore.getState());
      addToast({ type: "error", title: `图片生成失败: ${errorText}`, duration: 5000 });
    }

    _abortController = null;
  },

  async confirmVideoGeneration(messageId, partIndex, prompt, modelRef) {
    if (get().generating) return;

    set({
      generating: true,
      generatingType: "video",
      generatingProgress: 0,
      generatingStatus: "",
      generatingStartedAt: Date.now(),
    });

    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== messageId) return m;
        const newContent = [...m.content];
        newContent[partIndex] = { type: "loading", mediaType: "video" as const };
        return { ...m, content: newContent };
      }),
    }));

    _abortController = new AbortController();

    try {
      const { providerId, modelId } = parseModelRef(modelRef);
      const result = await providerService.generateVideo(providerId, {
        prompt,
        model: modelId,
        onProgress: (p) =>
          set({ generatingProgress: p.percent, generatingStatus: p.label }),
        signal: _abortController!.signal,
      });

      set((s) => ({
        messages: s.messages.map((m) => {
          if (m.id !== messageId) return m;
          const newContent = [...m.content];
          newContent[partIndex] = { type: "video", url: result.url, prompt };
          return { ...m, content: newContent, metadata: { ...m.metadata, model: modelId, intent: "video" as const } };
        }),
        generating: false,
        generatingType: null,
        generatingProgress: 0,
        generatingStatus: "",
        generatingStartedAt: 0,
      }));

      const msg = get().messages.find((m) => m.id === messageId);
      if (msg) {
        await saveChatMessage(messageToRow(msg));
      }
    } catch (e) {
      const errorText = e instanceof Error ? e.message : String(e);
      set((s) => ({
        messages: s.messages.map((m) => {
          if (m.id !== messageId) return m;
          const newContent = [...m.content];
          newContent[partIndex] = { type: "video_pending", prompt };
          return { ...m, content: newContent };
        }),
        generating: false,
        generatingType: null,
        generatingProgress: 0,
        generatingStatus: "",
        generatingStartedAt: 0,
      }));

      const msg = get().messages.find((m) => m.id === messageId);
      if (msg) await saveChatMessage(messageToRow(msg));

      const { addToast } = await import("@/stores/uiStore").then((m) => m.useUIStore.getState());
      addToast({ type: "error", title: `视频生成失败: ${errorText}`, duration: 5000 });
    }

    _abortController = null;
  },

  updatePendingPrompt(messageId, partIndex, prompt) {
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== messageId) return m;
        const part = m.content[partIndex];
        if (!part || (part.type !== "image_pending" && part.type !== "video_pending")) return m;
        const newContent = [...m.content];
        newContent[partIndex] = { ...part, prompt };
        return { ...m, content: newContent };
      }),
    }));
    const msg = get().messages.find((m) => m.id === messageId);
    if (msg) saveChatMessage(messageToRow(msg));
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
