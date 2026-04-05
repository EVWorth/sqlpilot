import { create } from "zustand";

export type ThemeMode = "dark" | "light" | "system";

interface ThemeState {
  theme: ThemeMode;
  effectiveTheme: "dark" | "light";
  setTheme: (theme: ThemeMode) => void;
}

function resolveEffective(theme: ThemeMode): "dark" | "light" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return theme;
}

function applyTheme(effective: "dark" | "light") {
  document.documentElement.dataset.theme = effective;
}

const stored = (() => {
  try {
    return (localStorage.getItem("theme") as ThemeMode) ?? "dark";
  } catch {
    return "dark" as ThemeMode;
  }
})();

const initialEffective = resolveEffective(stored);
applyTheme(initialEffective);

export const useThemeStore = create<ThemeState>((set) => ({
  theme: stored,
  effectiveTheme: initialEffective,

  setTheme: (theme) => {
    const effective = resolveEffective(theme);
    applyTheme(effective);
    try {
      localStorage.setItem("theme", theme);
    } catch {
      // localStorage unavailable
    }
    set({ theme, effectiveTheme: effective });
  },
}));

// Listen for system preference changes when mode is 'system'
if (typeof window !== "undefined") {
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      const state = useThemeStore.getState();
      if (state.theme === "system") {
        const effective = resolveEffective("system");
        applyTheme(effective);
        useThemeStore.setState({ effectiveTheme: effective });
      }
    });
}
