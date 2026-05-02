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
import type { ChatSessionRow, ChatMessageRow, ChatHistoryMessage, ChatContentPart } from "@/types";
import { generateTitle } from "@/lib/chatService";
import { modelService } from "@/services/models";
import { providerService } from "@/services/provider.service";
import { useProviderStore, parseModelRef } from "@/stores/providerStore";
import { getAccumulatedToolCalls } from "@/providers/openai-compat/formatter";
import { getBase64ForApi, persistImage } from "@/lib/media";
import { useProjectStore } from "@/stores/projectStore";
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
function pickImageModelRefForChat(
  chatProviderId: string,
  chatModelId: string,
  fallbackImageRef: string,
): string {
  const id = (chatModelId || "").toLowerCase();
  if (id.includes("gpt")) {
    return `${chatProviderId}:gpt-image-2`;
  }
  if (id.includes("gemini")) {
    if (chatProviderId === "jijing") return "jijing:nano-banana-2";
    return "comfly:gemini-3.1-flash-image-preview";
  }
  return fallbackImageRef;
}

// 注意：projectId 必须由调用方在任务"发起时刻"锁定后传入，
// 否则当用户在生成中途切换项目时，结果会被错误地写到新项目目录下。
async function persistGeneratedMedia(
  url: string,
  prompt: string | undefined,
  projectId: string | undefined,
): Promise<string> {
  // provider 已经在内部调用过 saveMedia 时返回的就是 media/... 相对路径，
  // 这种情况下文件已落盘，没必要再走一次 IPC 重存（重存会触发 std::fs::read 拿相对路径报错）。
  if (url.startsWith("media/")) return url;
  try {
    const { localPath } = await persistImage(url, prompt, projectId);
    return localPath;
  } catch (e) {
    console.warn("[chatStore] Failed to persist generated media:", e);
    return url;
  }
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

// ── Generation 状态（按会话隔离） ───────────────────────────

export interface GenerationState {
  generating: boolean;
  generatingType: "image" | "video" | null;
  generatingProgress: number;
  generatingStatus: string;
  generatingStartedAt: number;
  streamingText: string;
}

const DEFAULT_GENERATION: GenerationState = {
  generating: false,
  generatingType: null,
  generatingProgress: 0,
  generatingStatus: "",
  generatingStartedAt: 0,
  streamingText: "",
};

// ── 输入草稿（含未发送的文本与参考图，按会话隔离） ─────────
//
// 提升到 store 是为了避免：
//  - 切换项目时 ChatPanel 整体卸载，本地 useState 丢失参考图
//  - 切换会话后再切回时输入残稿丢失

export interface ChatInputMedia {
  url: string;
  displayUrl: string;
  kind: "image" | "video";
}

export interface ChatInputDraft {
  text: string;
  media: ChatInputMedia[];
}

export const EMPTY_INPUT_DRAFT: ChatInputDraft = { text: "", media: [] };

// currentSessionId 为 null 时（尚未创建会话）使用的占位 key，
// 发送后会在 sendMessage 中迁移到真正的 sessionId。
// 具体草稿 key 需要再拼上 projectId，避免无会话项目之间共享草稿。
export const PENDING_DRAFT_KEY = "__pending__";
const GLOBAL_PROJECT_KEY = "__global__";

function projectKey(projectId: string | null | undefined): string {
  return projectId ?? GLOBAL_PROJECT_KEY;
}

export function getPendingDraftKey(projectId: string | null | undefined): string {
  return `${PENDING_DRAFT_KEY}:${projectKey(projectId)}`;
}

// ── Store ───────────────────────────────────────────────────

interface ChatState {
  sessions: ChatSession[];
  currentSessionId: string | null;

  // 当前正在展示的项目；会话列表与 currentSessionId 仅代表该项目。
  // 其他项目的消息 / 生成态保留在下面的全局 map 中，切换项目不再中断后台任务。
  currentProjectId: string | null;

  // 主存储：按 sessionId 索引（避免跨会话污染）
  messagesBySession: Record<string, ChatMessage[]>;
  generationBySession: Record<string, GenerationState>;
  // 输入草稿：按 sessionId（或 PENDING_DRAFT_KEY）索引
  inputDraftBySession: Record<string, ChatInputDraft>;

  // 派生字段（始终指向当前 sessionId 的状态，由 applyDerived 自动同步，请勿直接修改）
  messages: ChatMessage[];
  generating: boolean;
  generatingType: "image" | "video" | null;
  generatingProgress: number;
  generatingStatus: string;
  generatingStartedAt: number;
  streamingText: string;

  chatModel: string;
  imageModel: string;
  videoModel: string;

  // 统一入口：切换聊天面板到指定项目。
  // 同步设置 currentProjectId，按需 reset 可见状态，然后异步加载该项目的会话。
  openProjectChat: (projectId: string) => Promise<void>;
  loadSessions: (projectId?: string) => Promise<void>;
  createSession: (projectId?: string) => Promise<string>;
  switchSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;

  // 输入草稿管理
  setInputDraft: (key: string, patch: Partial<ChatInputDraft>) => void;
  clearInputDraft: (key: string) => void;

  sendMessage: (text: string, imageUrls?: string[], videoUrls?: string[]) => Promise<void>;
  confirmImageGeneration: (messageId: string, partIndex: number, prompt: string, modelRef: string, size: string) => Promise<void>;
  confirmVideoGeneration: (messageId: string, partIndex: number, prompt: string, modelRef: string) => Promise<void>;
  updatePendingPrompt: (messageId: string, partIndex: number, prompt: string) => void;
  stopGenerating: (sessionId?: string) => void;
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

// 根据嵌套主存储计算派生字段（保证 messages/generating/... 始终对应当前 sessionId）
function applyDerived<S extends Pick<ChatState, "currentSessionId" | "messagesBySession" | "generationBySession">>(
  next: S,
): {
  messages: ChatMessage[];
  generating: boolean;
  generatingType: "image" | "video" | null;
  generatingProgress: number;
  generatingStatus: string;
  generatingStartedAt: number;
  streamingText: string;
} {
  const sid = next.currentSessionId;
  const msgs = sid ? next.messagesBySession[sid] ?? [] : [];
  const gen = sid ? next.generationBySession[sid] ?? DEFAULT_GENERATION : DEFAULT_GENERATION;
  return {
    messages: msgs,
    generating: gen.generating,
    generatingType: gen.generatingType,
    generatingProgress: gen.generatingProgress,
    generatingStatus: gen.generatingStatus,
    generatingStartedAt: gen.generatingStartedAt,
    streamingText: gen.streamingText,
  };
}

function getSessionsForProject(state: ChatState, projectId: string | null): ChatSession[] {
  return state.sessions.filter((session) => (session.projectId ?? null) === projectId);
}

function getFirstSessionIdForProject(state: ChatState, projectId: string | null): string | null {
  return getSessionsForProject(state, projectId)[0]?.id ?? null;
}

function sessionBelongsToCurrentProject(state: ChatState, sessionId: string | null): boolean {
  if (!sessionId) return false;
  return state.sessions.some(
    (session) => session.id === sessionId && (session.projectId ?? null) === state.currentProjectId,
  );
}

function visibleState(
  state: ChatState,
  currentSessionId: string | null,
): Pick<ChatState, "currentSessionId" | "messages" | "generating" | "generatingType" | "generatingProgress" | "generatingStatus" | "generatingStartedAt" | "streamingText"> {
  return {
    currentSessionId,
    ...applyDerived({ ...state, currentSessionId }),
  };
}

// ── 内部 helper：scope 到指定 sessionId 更新嵌套主存储 ──

function patchSessionMessagesIfVisible(
  state: ChatState,
  sid: string,
  updater: (prev: ChatMessage[]) => ChatMessage[],
): Partial<ChatState> {
  const prev = state.messagesBySession[sid] ?? [];
  const nextMessagesBySession = {
    ...state.messagesBySession,
    [sid]: updater(prev),
  };
  const patch: Partial<ChatState> = { messagesBySession: nextMessagesBySession };
  if (state.currentSessionId === sid) {
    const next = { ...state, messagesBySession: nextMessagesBySession };
    Object.assign(patch, applyDerived(next));
  }
  return patch;
}

function patchSessionGenerationIfVisible(
  state: ChatState,
  sid: string,
  patch: Partial<GenerationState>,
): Partial<ChatState> {
  const prev = state.generationBySession[sid] ?? DEFAULT_GENERATION;
  const nextGen = { ...prev, ...patch };
  const nextGenerationBySession = {
    ...state.generationBySession,
    [sid]: nextGen,
  };
  const result: Partial<ChatState> = { generationBySession: nextGenerationBySession };
  if (state.currentSessionId === sid) {
    const next = { ...state, generationBySession: nextGenerationBySession };
    Object.assign(result, applyDerived(next));
  }
  return result;
}

// AbortController 按会话隔离，避免互相终止
const abortControllers = new Map<string, AbortController>();

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  currentProjectId: null,

  messagesBySession: {},
  generationBySession: {},
  inputDraftBySession: {},

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

  async openProjectChat(projectId) {
    const pid = projectId;
    const prev = get().currentProjectId;

    // 1. 同步设置 currentProjectId；后续 createSession / sendMessage 的 shouldShow 依赖此值。
    if (prev !== pid) {
      set((s) => ({
        currentProjectId: pid,
        sessions: [],
        currentSessionId: null,
        ...applyDerived({ ...s, currentSessionId: null, messagesBySession: {}, generationBySession: s.generationBySession }),
      }));
    } else {
      set({ currentProjectId: pid });
    }

    // 2. 异步加载该项目的会话列表
    await get().loadSessions(pid);
  },

  async loadSessions(projectId) {
    const pid = projectId ?? useProjectStore.getState().currentProjectId ?? null;
    const rows = await listChatSessions(pid ?? undefined);
    const loadedSessions = rows.map(rowToSession);

    set((s) => {
      const sessions = [
        ...s.sessions.filter((session) => (session.projectId ?? null) !== pid),
        ...loadedSessions,
      ];
      if (s.currentProjectId !== pid) {
        return { sessions };
      }
      const base = { ...s, sessions } as ChatState;
      const currentStillVisible = sessionBelongsToCurrentProject(base, s.currentSessionId);
      const currentSessionId = currentStillVisible
        ? s.currentSessionId
        : getFirstSessionIdForProject(base, pid);
      return {
        sessions,
        ...visibleState(base, currentSessionId),
      };
    });

    const sid = get().currentProjectId === pid ? get().currentSessionId : null;
    if (sid && get().messagesBySession[sid] === undefined) {
      const msgRows = await loadChatMessages(sid);
      const msgs = msgRows.map(rowToMessage);
      set((s) => patchSessionMessagesIfVisible(s, sid, () => msgs));
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

  async createSession(projectId) {
    const id = crypto.randomUUID();
    const pid = projectId ?? get().currentProjectId ?? useProjectStore.getState().currentProjectId ?? undefined;
    const row = await createChatSession(id, "新对话", pid);
    const session = rowToSession(row);
    set((s) => {
      const messagesBySession = { ...s.messagesBySession, [id]: [] };
      const generationBySession = { ...s.generationBySession, [id]: { ...DEFAULT_GENERATION } };
      // 把对应项目的临时 pending 草稿（如果有）迁移到新建会话，保留用户已输入的内容
      const pendingDraftKey = getPendingDraftKey(pid);
      const pendingDraft = s.inputDraftBySession[pendingDraftKey];
      const inputDraftBySession = { ...s.inputDraftBySession };
      delete inputDraftBySession[pendingDraftKey];
      if (pendingDraft && (pendingDraft.text || pendingDraft.media.length > 0)) {
        inputDraftBySession[id] = pendingDraft;
      }
      const sessions = [session, ...s.sessions];
      const shouldShow = (session.projectId ?? null) === s.currentProjectId;
      const currentSessionId = shouldShow ? id : s.currentSessionId;
      const next = { ...s, sessions, currentSessionId, messagesBySession, generationBySession, inputDraftBySession };
      return {
        sessions,
        currentSessionId,
        messagesBySession,
        generationBySession,
        inputDraftBySession,
        ...applyDerived(next),
      };
    });
    return id;
  },


  setInputDraft(key, patch) {
    set((s) => {
      const prev = s.inputDraftBySession[key] ?? EMPTY_INPUT_DRAFT;
      const merged: ChatInputDraft = {
        text: patch.text !== undefined ? patch.text : prev.text,
        media: patch.media !== undefined ? patch.media : prev.media,
      };
      return {
        inputDraftBySession: { ...s.inputDraftBySession, [key]: merged },
      };
    });
  },

  clearInputDraft(key) {
    set((s) => {
      if (!(key in s.inputDraftBySession)) return s;
      const next = { ...s.inputDraftBySession };
      delete next[key];
      return { inputDraftBySession: next };
    });
  },

  async switchSession(id) {
    const cached = get().messagesBySession[id];
    let msgs: ChatMessage[];
    if (cached !== undefined) {
      // 已加载过（含空数组），直接使用内存缓存，避免覆盖进行中任务的实时更新
      msgs = cached;
    } else {
      const rows = await loadChatMessages(id);
      msgs = rows.map(rowToMessage);
    }
    set((s) => {
      const messagesBySession = { ...s.messagesBySession, [id]: msgs };
      const session = s.sessions.find((item) => item.id === id);
      const currentProjectId = session ? session.projectId ?? null : s.currentProjectId;
      const next = { ...s, currentProjectId, currentSessionId: id, messagesBySession };
      return {
        currentProjectId,
        currentSessionId: id,
        messagesBySession,
        ...applyDerived(next),
      };
    });
  },

  async deleteSession(id) {
    await deleteChatSession(id);

    // 同步终止该会话可能存在的进行中生成
    const ac = abortControllers.get(id);
    if (ac) {
      ac.abort();
      abortControllers.delete(id);
    }

    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id);
      const isCurrent = s.currentSessionId === id;
      const messagesBySession = { ...s.messagesBySession };
      delete messagesBySession[id];
      const generationBySession = { ...s.generationBySession };
      delete generationBySession[id];
      const inputDraftBySession = { ...s.inputDraftBySession };
      delete inputDraftBySession[id];

      const nextSid = isCurrent ? getFirstSessionIdForProject({ ...s, sessions } as ChatState, s.currentProjectId) : s.currentSessionId;
      const next = {
        ...s,
        sessions,
        currentSessionId: nextSid,
        messagesBySession,
        generationBySession,
        inputDraftBySession,
      };
      return {
        sessions,
        currentSessionId: nextSid,
        messagesBySession,
        generationBySession,
        inputDraftBySession,
        ...applyDerived(next),
      };
    });

    const state = get();
    if (state.currentSessionId && state.currentSessionId !== id) {
      const cur = state.currentSessionId;
      if (state.messagesBySession[cur] === undefined) {
        const rows = await loadChatMessages(cur);
        const msgs = rows.map(rowToMessage);
        set((s) => patchSessionMessagesIfVisible(s, cur, () => msgs));
      }
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
    const lockedProjectId = state.currentProjectId ?? useProjectStore.getState().currentProjectId ?? null;
    const lockedPid = lockedProjectId ?? undefined;
    const lockedChatRef = useProviderStore.getState().activeChatRef;
    const lockedImageRef = useProviderStore.getState().activeImageRef;

    const hasImages = imageUrls && imageUrls.length > 0;
    const hasVideos = videoUrls && videoUrls.length > 0;
    const hasMedia = hasImages || hasVideos;
    if (!text.trim() && !hasMedia) return;

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

    // 锁定本次任务的 sessionId / projectId（一旦确定就不再受项目切换影响）
    let sessionId = get().currentSessionId;
    const existingSession = sessionId
      ? get().sessions.find((session) => session.id === sessionId)
      : undefined;
    if (existingSession && (existingSession.projectId ?? null) !== lockedProjectId) {
      sessionId = getFirstSessionIdForProject(get(), lockedProjectId);
    }
    if (!sessionId) {
      sessionId = await get().createSession(lockedPid);
    }
    const sid = sessionId;

    // 仅检查【该会话】是否已有进行中的生成；不影响其他会话
    if ((get().generationBySession[sid] ?? DEFAULT_GENERATION).generating) return;

    set((s) => patchSessionGenerationIfVisible(s, sid, {
      generating: true,
      generatingType: null,
      generatingProgress: 0,
      generatingStatus: "",
      generatingStartedAt: Date.now(),
      streamingText: "",
    }));

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
      sessionId: sid,
      role: "user",
      content: userContent,
      createdAt: new Date().toISOString(),
    };

    set((s) => patchSessionMessagesIfVisible(s, sid, (prev) => [...prev, userMsg]));

    // 用户消息已入消息列表，清掉该会话与 pending 草稿（避免下次切回还残留）
    set((s) => {
      const next = { ...s.inputDraftBySession };
      delete next[sid];
      delete next[getPendingDraftKey(lockedPid)];
      return { inputDraftBySession: next };
    });

    await saveChatMessage(messageToRow(userMsg));

    const isFirstMessage = (get().messagesBySession[sid] ?? []).length === 1;

    const ac = new AbortController();
    abortControllers.set(sid, ac);

    try {
      const history: ChatHistoryMessage[] = (get().messagesBySession[sid] ?? []).map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const { providerId, modelId } = parseModelRef(lockedChatRef);

      let fullText = "";
      const unifiedMessages = await historyToUnified(history);
      const streamResult = await new Promise<{
        textParts: ChatContentPart[];
        imageJobs: { prompt: string; size?: string }[];
        videoJobs: { prompt: string }[];
      }>((resolve, reject) => {
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
                  set((s) => patchSessionGenerationIfVisible(s, sid, {
                    streamingText: (s.generationBySession[sid]?.streamingText ?? "") + event.text,
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
                  set((s) => patchSessionGenerationIfVisible(s, sid, { streamingText: "" }));
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
        sessionId: sid,
        role: "assistant",
        content: initialContent,
        metadata: {
          model: modelId,
        },
        createdAt: new Date().toISOString(),
      };
      set((s) => patchSessionMessagesIfVisible(s, sid, (prev) => [...prev, assistantMsg]));

      if (streamResult.imageJobs.length === 0) {
        set((s) => patchSessionGenerationIfVisible(s, sid, {
          generating: false,
          generatingType: null,
          generatingProgress: 0,
          generatingStatus: "",
          generatingStartedAt: 0,
          streamingText: "",
        }));
        await saveChatMessage(messageToRow(assistantMsg));
      } else {
        set((s) => patchSessionGenerationIfVisible(s, sid, {
          generatingType: "image",
          generatingProgress: 0,
          generatingStatus: "",
          generatingStartedAt: Date.now(),
          streamingText: "",
        }));

        const { providerId: chatProvId, modelId: chatModId } = parseModelRef(lockedChatRef);
        const imageRef = pickImageModelRefForChat(chatProvId, chatModId, lockedImageRef);
        const { providerId: imgProvId, modelId: imgModId } = parseModelRef(imageRef);
        useProviderStore.getState().setActiveRef("image", imageRef);
        const allowedSizes = getAllowedSizesForModel(imgModId);

        // 把当前用户消息附带的图片转成 referenceImages，传给生图模型；
        // 否则 chat 模型虽然"看过"图，但生图阶段只拿到文字 prompt，会丢失视觉特征
        const refImages = hasImages
          ? await Promise.all(
              imageUrls!.map(async (url, i) => ({
                url: await getBase64ForApi(url),
                role: `refImage${i}`,
              })),
            )
          : undefined;

        for (let i = 0; i < streamResult.imageJobs.length; i++) {
          const job = streamResult.imageJobs[i]!;
          const partIdx = imageLoadingIndices[i]!;
          const finalSize = coerceToAllowedSize(job.size || "1:1", allowedSizes);
          try {
            const result = await providerService.generateImage(imgProvId, {
              prompt: job.prompt,
              model: imgModId,
              size: finalSize,
              referenceImages: refImages && refImages.length > 0 ? refImages : undefined,
              onProgress: (p) =>
                set((s) => patchSessionGenerationIfVisible(s, sid, {
                  generatingProgress: p.percent,
                  generatingStatus: p.label,
                })),
              signal: ac.signal,
            });
            const savedUrl = await persistGeneratedMedia(result.url, job.prompt, lockedPid);
            set((s) => patchSessionMessagesIfVisible(s, sid, (prev) =>
              prev.map((m) => {
                if (m.id !== assistantId) return m;
                const newContent = [...m.content];
                newContent[partIdx] = {
                  type: "image",
                  url: savedUrl,
                  prompt: job.prompt,
                };
                return { ...m, content: newContent };
              }),
            ));
          } catch (e) {
            const errorText = e instanceof Error ? e.message : String(e);
            set((s) => patchSessionMessagesIfVisible(s, sid, (prev) =>
              prev.map((m) => {
                if (m.id !== assistantId) return m;
                const newContent = [...m.content];
                newContent[partIdx] = {
                  type: "text",
                  text: `\n图片生成失败: ${errorText}`,
                };
                return { ...m, content: newContent };
              }),
            ));
          }
        }

        set((s) => patchSessionGenerationIfVisible(s, sid, {
          generating: false,
          generatingType: null,
          generatingProgress: 0,
          generatingStatus: "",
          generatingStartedAt: 0,
        }));
        const finalMsg = (get().messagesBySession[sid] ?? []).find((m) => m.id === assistantId);
        if (finalMsg) await saveChatMessage(messageToRow(finalMsg));
      }

      if (isFirstMessage && sid) {
        const firstText = text.slice(0, 200);
        const titleModel =
          get().chatModel ||
          parseModelRef(lockedChatRef).modelId;
        if (titleModel) {
          generateTitle(firstText, titleModel).then((title) => {
            if (title && title !== "新对话") {
              get().renameSession(sid, title);
            }
          }).catch(() => {});
        }
      }
    } catch (e) {
      const errorText =
        e instanceof Error ? e.message : String(e);

      const errorMsg: ChatMessage = {
        id: crypto.randomUUID(),
        sessionId: sid,
        role: "assistant",
        content: [{ type: "text", text: `Error: ${errorText}` }],
        createdAt: new Date().toISOString(),
      };

      set((s) => {
        const partA = patchSessionMessagesIfVisible(s, sid, (prev) => [...prev, errorMsg]);
        const merged = { ...s, ...partA } as ChatState;
        const partB = patchSessionGenerationIfVisible(merged, sid, {
          generating: false,
          generatingType: null,
          generatingProgress: 0,
          generatingStatus: "",
          generatingStartedAt: 0,
          streamingText: "",
        });
        return { ...partA, ...partB };
      });

      await saveChatMessage(messageToRow(errorMsg));
    }

    abortControllers.delete(sid);
  },

  async confirmImageGeneration(messageId, partIndex, prompt, modelRef, size) {
    const sid = get().currentSessionId;
    if (!sid) return;
    if ((get().generationBySession[sid] ?? DEFAULT_GENERATION).generating) return;
    // 入口锁定 pid，避免生成中途切项目导致结果落到错误目录
    const lockedPid = get().currentProjectId ?? useProjectStore.getState().currentProjectId ?? undefined;

    set((s) => patchSessionGenerationIfVisible(s, sid, {
      generating: true,
      generatingType: "image",
      generatingProgress: 0,
      generatingStatus: "",
      generatingStartedAt: Date.now(),
    }));

    set((s) => patchSessionMessagesIfVisible(s, sid, (prev) =>
      prev.map((m) => {
        if (m.id !== messageId) return m;
        const newContent = [...m.content];
        newContent[partIndex] = { type: "loading", mediaType: "image" as const };
        return { ...m, content: newContent };
      }),
    ));

    const ac = new AbortController();
    abortControllers.set(sid, ac);

    try {
      const { providerId, modelId } = parseModelRef(modelRef);
      const result = await providerService.generateImage(providerId, {
        prompt,
        model: modelId,
        size: size || undefined,
        onProgress: (p) =>
          set((s) => patchSessionGenerationIfVisible(s, sid, {
            generatingProgress: p.percent,
            generatingStatus: p.label,
          })),
        signal: ac.signal,
      });
      const savedUrl = await persistGeneratedMedia(result.url, prompt, lockedPid);

      set((s) => {
        const partA = patchSessionMessagesIfVisible(s, sid, (prev) =>
          prev.map((m) => {
            if (m.id !== messageId) return m;
            const newContent = [...m.content];
            newContent[partIndex] = { type: "image", url: savedUrl, prompt };
            return { ...m, content: newContent, metadata: { ...m.metadata, model: modelId } };
          }),
        );
        const merged = { ...s, ...partA } as ChatState;
        const partB = patchSessionGenerationIfVisible(merged, sid, {
          generating: false,
          generatingType: null,
          generatingProgress: 0,
          generatingStatus: "",
          generatingStartedAt: 0,
        });
        return { ...partA, ...partB };
      });

      const msg = (get().messagesBySession[sid] ?? []).find((m) => m.id === messageId);
      if (msg) {
        await saveChatMessage(messageToRow(msg));
      }
    } catch (e) {
      const errorText = e instanceof Error ? e.message : String(e);
      set((s) => {
        const partA = patchSessionMessagesIfVisible(s, sid, (prev) =>
          prev.map((m) => {
            if (m.id !== messageId) return m;
            const newContent = [...m.content];
            newContent[partIndex] = { type: "image_pending", prompt, suggestedSize: size };
            return { ...m, content: newContent };
          }),
        );
        const merged = { ...s, ...partA } as ChatState;
        const partB = patchSessionGenerationIfVisible(merged, sid, {
          generating: false,
          generatingType: null,
          generatingProgress: 0,
          generatingStatus: "",
          generatingStartedAt: 0,
        });
        return { ...partA, ...partB };
      });

      const msg = (get().messagesBySession[sid] ?? []).find((m) => m.id === messageId);
      if (msg) await saveChatMessage(messageToRow(msg));

      const { addToast } = await import("@/stores/uiStore").then((m) => m.useUIStore.getState());
      addToast({ type: "error", title: `图片生成失败: ${errorText}`, duration: 5000 });
    }

    abortControllers.delete(sid);
  },

  async confirmVideoGeneration(messageId, partIndex, prompt, modelRef) {
    const sid = get().currentSessionId;
    if (!sid) return;
    if ((get().generationBySession[sid] ?? DEFAULT_GENERATION).generating) return;
    // 入口锁定 pid，避免生成中途切项目导致结果落到错误目录
    const lockedPid = get().currentProjectId ?? useProjectStore.getState().currentProjectId ?? undefined;

    set((s) => patchSessionGenerationIfVisible(s, sid, {
      generating: true,
      generatingType: "video",
      generatingProgress: 0,
      generatingStatus: "",
      generatingStartedAt: Date.now(),
    }));

    set((s) => patchSessionMessagesIfVisible(s, sid, (prev) =>
      prev.map((m) => {
        if (m.id !== messageId) return m;
        const newContent = [...m.content];
        newContent[partIndex] = { type: "loading", mediaType: "video" as const };
        return { ...m, content: newContent };
      }),
    ));

    const ac = new AbortController();
    abortControllers.set(sid, ac);

    try {
      const { providerId, modelId } = parseModelRef(modelRef);
      const result = await providerService.generateVideo(providerId, {
        prompt,
        model: modelId,
        onProgress: (p) =>
          set((s) => patchSessionGenerationIfVisible(s, sid, {
            generatingProgress: p.percent,
            generatingStatus: p.label,
          })),
        signal: ac.signal,
      });
      const savedUrl = await persistGeneratedMedia(result.url, prompt, lockedPid);

      set((s) => {
        const partA = patchSessionMessagesIfVisible(s, sid, (prev) =>
          prev.map((m) => {
            if (m.id !== messageId) return m;
            const newContent = [...m.content];
            newContent[partIndex] = { type: "video", url: savedUrl, prompt };
            return { ...m, content: newContent, metadata: { ...m.metadata, model: modelId } };
          }),
        );
        const merged = { ...s, ...partA } as ChatState;
        const partB = patchSessionGenerationIfVisible(merged, sid, {
          generating: false,
          generatingType: null,
          generatingProgress: 0,
          generatingStatus: "",
          generatingStartedAt: 0,
        });
        return { ...partA, ...partB };
      });

      const msg = (get().messagesBySession[sid] ?? []).find((m) => m.id === messageId);
      if (msg) {
        await saveChatMessage(messageToRow(msg));
      }
    } catch (e) {
      const errorText = e instanceof Error ? e.message : String(e);
      set((s) => {
        const partA = patchSessionMessagesIfVisible(s, sid, (prev) =>
          prev.map((m) => {
            if (m.id !== messageId) return m;
            const newContent = [...m.content];
            newContent[partIndex] = { type: "video_pending", prompt };
            return { ...m, content: newContent };
          }),
        );
        const merged = { ...s, ...partA } as ChatState;
        const partB = patchSessionGenerationIfVisible(merged, sid, {
          generating: false,
          generatingType: null,
          generatingProgress: 0,
          generatingStatus: "",
          generatingStartedAt: 0,
        });
        return { ...partA, ...partB };
      });

      const msg = (get().messagesBySession[sid] ?? []).find((m) => m.id === messageId);
      if (msg) await saveChatMessage(messageToRow(msg));

      const { addToast } = await import("@/stores/uiStore").then((m) => m.useUIStore.getState());
      addToast({ type: "error", title: `视频生成失败: ${errorText}`, duration: 5000 });
    }

    abortControllers.delete(sid);
  },

  updatePendingPrompt(messageId, partIndex, prompt) {
    const sid = get().currentSessionId;
    if (!sid) return;
    set((s) => patchSessionMessagesIfVisible(s, sid, (prev) =>
      prev.map((m) => {
        if (m.id !== messageId) return m;
        const part = m.content[partIndex];
        if (!part || (part.type !== "image_pending" && part.type !== "video_pending")) return m;
        const newContent = [...m.content];
        newContent[partIndex] = { ...part, prompt };
        return { ...m, content: newContent };
      }),
    ));
    const msg = (get().messagesBySession[sid] ?? []).find((m) => m.id === messageId);
    if (msg) saveChatMessage(messageToRow(msg));
  },

  stopGenerating(sessionId) {
    const sid = typeof sessionId === "string" ? sessionId : get().currentSessionId;
    if (!sid) return;
    const ac = abortControllers.get(sid);
    if (import.meta.env.DEV && ac) {
      console.trace("[chatStore] stopGenerating called for session:", sid);
    }
    ac?.abort();
    abortControllers.delete(sid);
    set((s) => patchSessionGenerationIfVisible(s, sid, {
      generating: false,
      generatingType: null,
      generatingProgress: 0,
      generatingStatus: "",
      generatingStartedAt: 0,
      streamingText: "",
    }));
  },

  async clearMessages() {
    const sid = get().currentSessionId;
    if (!sid) return;
    await clearChatMessages(sid);
    set((s) => {
      const partA = patchSessionMessagesIfVisible(s, sid, () => []);
      const merged = { ...s, ...partA } as ChatState;
      const partB = patchSessionGenerationIfVisible(merged, sid, { streamingText: "" });
      return { ...partA, ...partB };
    });
  },

}));
