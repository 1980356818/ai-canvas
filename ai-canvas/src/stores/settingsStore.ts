import { create } from "zustand";

export type Theme = "light" | "dark" | "system";

interface SettingsState {
  theme: Theme;

  setTheme: (theme: Theme) => void;
  applyTheme: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: "system",

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
}));
