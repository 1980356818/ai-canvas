import { create } from "zustand";
import { registry } from "@/providers/registry";

interface ProviderStoreState {
  activeChatRef: string;
  activeImageRef: string;
  activeVideoRef: string;

  initialized: boolean;

  setActiveRef(scene: "chat" | "image" | "video", ref: string): void;
  initialize(): Promise<void>;
}

function persistRef(key: string, value: string) {
  try { localStorage.setItem(`ai_canvas_provider_${key}`, value); } catch { /* ignore */ }
}

function loadRef(key: string, fallback: string): string {
  try { return localStorage.getItem(`ai_canvas_provider_${key}`) ?? fallback; } catch { return fallback; }
}

// AI 聊天 / 视频统一走极境;图片仍保留 comfly 默认(还有 nano-banana-pro 可选)。
const DEFAULT_CHAT_REF = "jijing:gemini-3.1-pro-preview";
const DEFAULT_IMAGE_REF = "comfly:gemini-3.1-flash-image-preview";
const DEFAULT_VIDEO_REF = "jijing:veo3.1";

// 老用户 localStorage 里可能存了 comfly chat ref;这些模型已下线,
// 强制迁移到极境默认,避免 dropdown 显示不存在的选项。
const STALE_CHAT_REFS = new Set([
  "comfly:gpt-5.4",
  "comfly:gemini-3.1-pro-preview-thinking-high",
  "comfly:gemini-3.1-pro-preview",
]);

// Comfly video 也已下线;`comfly:veo*` / `comfly:seedance*` 一律视为失效,
// 包括 canonical alias 和历史 sku (veo3.1-fast / -4k / -ref / -pro-* 等)。
function isStaleVideoRef(ref: string): boolean {
  return ref.startsWith("comfly:veo") || ref.startsWith("comfly:seedance");
}

function loadChatRef(): string {
  const raw = loadRef("chat", DEFAULT_CHAT_REF);
  if (STALE_CHAT_REFS.has(raw)) {
    persistRef("chat", DEFAULT_CHAT_REF);
    return DEFAULT_CHAT_REF;
  }
  return raw;
}

function loadVideoRef(): string {
  const raw = loadRef("video", DEFAULT_VIDEO_REF);
  if (isStaleVideoRef(raw)) {
    persistRef("video", DEFAULT_VIDEO_REF);
    return DEFAULT_VIDEO_REF;
  }
  return raw;
}

export const useProviderStore = create<ProviderStoreState>((set) => ({
  activeChatRef: DEFAULT_CHAT_REF,
  activeImageRef: DEFAULT_IMAGE_REF,
  activeVideoRef: DEFAULT_VIDEO_REF,
  initialized: false,

  setActiveRef(scene, ref) {
    const key = scene === "chat" ? "activeChatRef"
      : scene === "image" ? "activeImageRef"
      : "activeVideoRef";
    set({ [key]: ref });
    persistRef(scene, ref);
  },

  async initialize() {
    await registry.loadConfigs();
    set({
      activeChatRef: loadChatRef(),
      activeImageRef: loadRef("image", DEFAULT_IMAGE_REF),
      activeVideoRef: loadVideoRef(),
      initialized: true,
    });
  },
}));

export function parseModelRef(ref: string): { providerId: string; modelId: string } {
  const sep = ref.indexOf(":");
  if (sep < 0) return { providerId: "comfly", modelId: ref };
  return { providerId: ref.slice(0, sep), modelId: ref.slice(sep + 1) };
}
