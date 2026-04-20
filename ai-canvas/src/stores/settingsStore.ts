import { create } from "zustand";
import { DEFAULT_IMAGE_SIZE, normalizeImageSize } from "@/shared/constants";

export type Theme = "light" | "dark" | "system";

export type ModelCategory = "image" | "enhancer" | "video" | "chat" | "multiangle";

const LS_KEY_IMAGE_SIZE = "ai-canvas:lastImageSize";
const LS_KEY_THEME = "ai-canvas:theme";
const LS_KEY_MODEL_PREFIX = "ai-canvas:lastModel:";

interface ModelRef {
  modelId: string;
  providerId: string;
}

function loadLastImageSize(): string {
  try {
    return normalizeImageSize(localStorage.getItem(LS_KEY_IMAGE_SIZE) ?? undefined);
  } catch {
    return DEFAULT_IMAGE_SIZE;
  }
}

function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem(LS_KEY_THEME);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch { /* noop */ }
  return "system";
}

function loadLastModel(category: ModelCategory): ModelRef | null {
  try {
    const raw = localStorage.getItem(LS_KEY_MODEL_PREFIX + category);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.modelId && parsed.providerId) return parsed as ModelRef;
  } catch { /* noop */ }
  return null;
}

function saveLastModel(category: ModelCategory, ref: ModelRef): void {
  try {
    localStorage.setItem(LS_KEY_MODEL_PREFIX + category, JSON.stringify(ref));
  } catch { /* noop */ }
}

interface SettingsState {
  theme: Theme;
  lastImageSize: string;
  lastModels: Record<ModelCategory, ModelRef | null>;

  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  applyTheme: () => void;
  isDark: () => boolean;
  setLastImageSize: (size: string) => void;
  setLastModel: (category: ModelCategory, modelId: string, providerId: string) => void;
  getLastModel: (category: ModelCategory) => ModelRef | null;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: loadTheme(),
  lastImageSize: loadLastImageSize(),
  lastModels: {
    image: loadLastModel("image"),
    enhancer: loadLastModel("enhancer"),
    video: loadLastModel("video"),
    chat: loadLastModel("chat"),
    multiangle: loadLastModel("multiangle"),
  },

  setTheme: (theme) => {
    set({ theme });
    try { localStorage.setItem(LS_KEY_THEME, theme); } catch { /* noop */ }
    get().applyTheme();
  },

  toggleTheme: () => {
    const current = get().theme;
    const isDark = get().isDark();
    const next: Theme = isDark ? "light" : "dark";
    if (current === "system") {
      get().setTheme(next);
    } else {
      get().setTheme(current === "dark" ? "light" : "dark");
    }
  },

  applyTheme: () => {
    const { theme } = get();
    const root = document.documentElement;

    if (theme === "dark") {
      root.classList.add("dark");
    } else if (theme === "light") {
      root.classList.remove("dark");
    } else {
      const prefersDark = window.matchMedia(
        "(prefers-color-scheme: dark)",
      ).matches;
      root.classList.toggle("dark", prefersDark);
    }
  },

  isDark: () => {
    const { theme } = get();
    if (theme === "dark") return true;
    if (theme === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  },

  setLastImageSize: (size) => {
    set({ lastImageSize: size });
    try {
      localStorage.setItem(LS_KEY_IMAGE_SIZE, size);
    } catch { /* noop */ }
  },

  setLastModel: (category, modelId, providerId) => {
    const ref: ModelRef = { modelId, providerId };
    saveLastModel(category, ref);
    set({ lastModels: { ...get().lastModels, [category]: ref } });
  },

  getLastModel: (category) => {
    return get().lastModels[category];
  },
}));
