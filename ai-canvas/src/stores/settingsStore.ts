import { create } from "zustand";
import { DEFAULT_IMAGE_SIZE, normalizeImageSize } from "@/shared/constants";

export type Theme = "light" | "dark" | "system";

const LS_KEY_IMAGE_SIZE = "ai-canvas:lastImageSize";
const LS_KEY_THEME = "ai-canvas:theme";

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

interface SettingsState {
  theme: Theme;
  lastImageSize: string;

  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  applyTheme: () => void;
  isDark: () => boolean;
  setLastImageSize: (size: string) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: loadTheme(),
  lastImageSize: loadLastImageSize(),

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
}));
