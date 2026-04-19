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

export const useProviderStore = create<ProviderStoreState>((set) => ({
  activeChatRef: "comfly:gemini-3.1-pro-preview-thinking-high",
  activeImageRef: "comfly:gemini-3.1-flash-image-preview",
  activeVideoRef: "comfly:veo3.1-fast",
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
      activeChatRef: loadRef("chat", "comfly:gemini-3.1-pro-preview-thinking-high"),
      activeImageRef: loadRef("image", "comfly:gemini-3.1-flash-image-preview"),
      activeVideoRef: loadRef("video", "comfly:veo3.1-fast"),
      initialized: true,
    });
  },
}));

export function parseModelRef(ref: string): { providerId: string; modelId: string } {
  const sep = ref.indexOf(":");
  if (sep < 0) return { providerId: "comfly", modelId: ref };
  return { providerId: ref.slice(0, sep), modelId: ref.slice(sep + 1) };
}
