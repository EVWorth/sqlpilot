import { create } from "zustand";
import { applyThemeColors, BUILT_IN_THEMES, builtInTheme, parseTheme, type Theme } from "../lib/themes";
import { useStorageErrorStore } from "./storageErrorStore";

/**
 * Which theme is showing, and which ones exist.
 *
 * `theme` stayed a `dark | light | system` string long after that stopped
 * being the whole story (#350). It still means what it always did — the three
 * original modes are still there, and `system` still follows the OS — but it
 * now also holds the id of any other theme, built in or imported.
 */

export type ThemeMode = string;

/** Order the theme toggles step through: Dark → Light → System → Dark. */
export const themeOrder: ThemeMode[] = ["dark", "light", "system"];

const THEME_KEY = "theme";
const CUSTOM_KEY = "sqlpilot.custom-themes";

interface ThemeState {
  /** A theme id, or "system". */
  theme: ThemeMode;
  /** Which way the current theme reads, for Monaco and `color-scheme`. */
  effectiveTheme: "dark" | "light";
  /** Themes the user imported or made, alongside the built-ins. */
  customThemes: Theme[];
  setTheme: (theme: ThemeMode) => void;
  cycleTheme: () => void;
  /** Add or replace a custom theme, keyed on its id. */
  saveCustomTheme: (theme: Theme) => void;
  deleteCustomTheme: (id: string) => void;
  /** Import from a file's contents. Returns an error message, or null. */
  importTheme: (json: string) => string | null;
  /**
   * Show a theme without recording it — for the editor, where every keystroke
   * is a new palette and none of them should be what the app reopens as.
   */
  preview: (theme: Theme | null) => void;
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function readCustomThemes(): Theme[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Re-validated on the way in, not trusted because it came from us: the
    // file is editable, and a bad value here reaches the stylesheet.
    return parsed
      .map((t) => parseTheme(JSON.stringify(t)))
      .filter((t): t is Theme => !("error" in t));
  } catch {
    return [];
  }
}

function findTheme(id: string, custom: Theme[]): Theme | undefined {
  return builtInTheme(id) ?? custom.find((t) => t.id === id);
}

/**
 * The theme to actually show for a mode.
 *
 * "system" is not a theme; it is a rule for picking one. An id that no longer
 * names anything — an imported theme the user deleted, or one from a newer
 * version — falls back to Dark rather than leaving the app unstyled.
 */
function resolve(mode: ThemeMode, custom: Theme[]): Theme {
  if (mode === "system") {
    return builtInTheme(systemPrefersDark() ? "dark" : "light")!;
  }
  return findTheme(mode, custom) ?? builtInTheme("dark")!;
}

function apply(theme: Theme) {
  applyThemeColors(theme, document.documentElement);
}

const initialCustom = readCustomThemes();
const storedMode = (() => {
  try {
    return localStorage.getItem(THEME_KEY) ?? "dark";
  } catch {
    return "dark";
  }
})();
const initialTheme = resolve(storedMode, initialCustom);
apply(initialTheme);

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: storedMode,
  effectiveTheme: initialTheme.base,
  customThemes: initialCustom,

  setTheme: (theme) => {
    const resolved = resolve(theme, get().customThemes);
    apply(resolved);
    const { reportStorageError } = useStorageErrorStore.getState();
    try {
      localStorage.setItem(THEME_KEY, theme);
      reportStorageError("theme", null, "theme");
    } catch (e) {
      // Swallowing this meant the theme silently reverted on next launch.
      // (refs #348)
      reportStorageError("theme", e, "theme");
    }
    set({ theme, effectiveTheme: resolved.base });
  },

  cycleTheme: () => {
    // Only the three original modes are in the cycle. A toggle that stepped
    // through every imported theme would take as many clicks as the user has
    // themes, which is not a toggle.
    const idx = themeOrder.indexOf(get().theme);
    get().setTheme(themeOrder[(idx + 1) % themeOrder.length]);
  },

  saveCustomTheme: (theme) => {
    const custom = [
      ...get().customThemes.filter((t) => t.id !== theme.id),
      { ...theme, builtIn: false },
    ];
    persistCustom(custom);
    set({ customThemes: custom });
    // Re-apply when it is the one showing, so an edit takes effect on save
    // rather than on the next switch.
    if (get().theme === theme.id) get().setTheme(theme.id);
  },

  deleteCustomTheme: (id) => {
    const custom = get().customThemes.filter((t) => t.id !== id);
    persistCustom(custom);
    set({ customThemes: custom });
    // Deleting the theme in use would otherwise leave it on screen with
    // nothing behind it.
    if (get().theme === id) {
      set({ theme: "dark" });
      get().setTheme("dark");
    }
  },

  importTheme: (json) => {
    const parsed = parseTheme(json);
    if ("error" in parsed) return parsed.error;
    if (builtInTheme(parsed.id)) {
      // Shadowing a built-in id would make the original unreachable.
      parsed.id = `${parsed.id}-custom`;
    }
    get().saveCustomTheme(parsed);
    return null;
  },

  preview: (theme) => {
    apply(theme ?? resolve(get().theme, get().customThemes));
  },
}));

function persistCustom(themes: Theme[]) {
  const { reportStorageError } = useStorageErrorStore.getState();
  try {
    localStorage.setItem(
      CUSTOM_KEY,
      JSON.stringify(themes.map(({ id, name, base, colors }) => ({ id, name, base, colors }))),
    );
    reportStorageError("theme", null, "theme");
  } catch (e) {
    // A theme that cannot be saved is gone on the next launch, and silently
    // losing one someone built is worse than saying so (#348).
    reportStorageError("theme", e, "theme");
  }
}

/** Every theme the picker offers, built-ins first. */
export function allThemes(custom: Theme[]): Theme[] {
  return [...BUILT_IN_THEMES, ...custom];
}

// Use a const object wrapper to persist cleanup across HMR module reloads
const _mqlState = { cleanup: null as (() => void) | null };

if (typeof window !== "undefined") {
  _mqlState.cleanup?.();

  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    const state = useThemeStore.getState();
    if (state.theme === "system") {
      const resolved = resolve("system", state.customThemes);
      apply(resolved);
      useThemeStore.setState({ effectiveTheme: resolved.base });
    }
  };

  mql.addEventListener("change", handler);
  _mqlState.cleanup = () => mql.removeEventListener("change", handler);
}

/** Removes the system theme change listener. Useful for cleanup (e.g. in tests). */
export function cleanupThemeListener() {
  _mqlState.cleanup?.();
}
