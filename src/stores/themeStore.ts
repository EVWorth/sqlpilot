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

// Use a const object wrapper to persist cleanup across HMR module reloads
const _mqlState = { cleanup: null as (() => void) | null };

if (typeof window !== "undefined") {
  _mqlState.cleanup?.();

  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    const state = useThemeStore.getState();
    if (state.theme === "system") {
      const effective = resolveEffective("system");
      applyTheme(effective);
      useThemeStore.setState({ effectiveTheme: effective });
    }
  };

  mql.addEventListener("change", handler);
  _mqlState.cleanup = () => mql.removeEventListener("change", handler);
}

/** Removes the system theme change listener. Useful for cleanup (e.g. in tests). */
export function cleanupThemeListener() {
  _mqlState.cleanup?.();
}
