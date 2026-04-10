import { create } from "zustand";
import { DEFAULT_IMAGE_SIZE, normalizeImageSize } from "@/shared/constants";

export type Theme = "light" | "dark" | "system";

const LS_KEY_IMAGE_SIZE = "ai-canvas:lastImageSize";

function loadLastImageSize(): string {
  try {
    return normalizeImageSize(localStorage.getItem(LS_KEY_IMAGE_SIZE) ?? undefined);
  } catch {
    return DEFAULT_IMAGE_SIZE;
  }
}

interface SettingsState {
  theme: Theme;
  lastImageSize: string;

  setTheme: (theme: Theme) => void;
  applyTheme: () => void;
  setLastImageSize: (size: string) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: "system",
  lastImageSize: loadLastImageSize(),

  setTheme: (theme) => {
    set({ theme });
    get().applyTheme();
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

  setLastImageSize: (size) => {
    set({ lastImageSize: size });
    try {
      localStorage.setItem(LS_KEY_IMAGE_SIZE, size);
    } catch { /* noop */ }
  },
}));
