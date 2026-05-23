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
// 视频默认 = seedance (Veo 已从 dropdown 隐藏, 2026-05-24, 见 jijing/models.ts)。
const DEFAULT_VIDEO_REF = "jijing:seedance";

// 老用户 localStorage 里可能存了已下线的 comfly chat ref,
// 强制迁移到极境默认,避免 dropdown 显示不存在的选项。
const STALE_CHAT_REFS = new Set([
  "comfly:gemini-3.1-pro-preview-thinking-high",
]);

// Comfly video 也已下线;`comfly:veo*` / `comfly:seedance*` 一律视为失效,
// 包括 canonical alias 和历史 sku (veo3.1-fast / -4k / -ref / -pro-* 等)。
// 极境 veo 仍可后台生成 (兼容老卡片), 但已从 dropdown 隐藏 (2026-05-24),
// 所以 localStorage 里存的 `jijing:veo*` 也视为失效, 否则 dropdown 显示空。
function isStaleVideoRef(ref: string): boolean {
  if (ref.startsWith("comfly:veo") || ref.startsWith("comfly:seedance")) return true;
  if (ref.startsWith("jijing:veo")) return true;
  return false;
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
