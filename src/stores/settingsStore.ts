import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";

export interface QuerySettings {
  maxResultRows: number;
  limitEnabled: boolean;
}

const DEFAULT_QUERY_SETTINGS: QuerySettings = {
  maxResultRows: 1000,
  limitEnabled: true,
};

export interface FormatterSettings {
  keywordCase: "upper" | "lower" | "preserve";
  identifierCase: "upper" | "lower" | "preserve";
  dataTypeCase: "upper" | "lower" | "preserve";
  functionCase: "upper" | "lower" | "preserve";
  indentStyle: "standard" | "tabularLeft" | "tabularRight";
  tabWidth: number;
  useTabs: boolean;
  logicalOperatorNewline: "before" | "after";
  newlineBeforeSemicolon: boolean;
  expressionWidth: number;
  linesBetweenQueries: number;
  denseOperators: boolean;
}

const DEFAULT_FORMATTER_SETTINGS: FormatterSettings = {
  keywordCase: "upper",
  identifierCase: "preserve",
  dataTypeCase: "upper",
  functionCase: "preserve",
  indentStyle: "standard",
  tabWidth: 2,
  useTabs: false,
  logicalOperatorNewline: "before",
  newlineBeforeSemicolon: false,
  expressionWidth: 50,
  linesBetweenQueries: 1,
  denseOperators: false,
};

const QUERY_SETTINGS_KEY = "sqlpilot-query-settings";
const STORAGE_KEY = "sqlpilot-formatter-settings";

function loadQuerySettings(): QuerySettings {
  try {
    const stored = localStorage.getItem(QUERY_SETTINGS_KEY);
    if (stored) {
      return { ...DEFAULT_QUERY_SETTINGS, ...JSON.parse(stored) };
    }
  } catch {
    // ignore
  }
  return DEFAULT_QUERY_SETTINGS;
}

function loadSettings(): FormatterSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...DEFAULT_FORMATTER_SETTINGS, ...JSON.parse(stored) };
    }
  } catch {
    // ignore
  }
  return DEFAULT_FORMATTER_SETTINGS;
}

interface SettingsState {
  querySettings: QuerySettings;
  formatterSettings: FormatterSettings;
  updateStatus: "idle" | "checking" | "available" | "downloading" | "downloaded" | "up-to-date" | "error";
  updateVersion: string | null;
  updateError: string | null;
  pendingUpdate: Update | null;
  checkForUpdates: () => Promise<void>;
  installUpdate: () => Promise<void>;
  setUpdateError: (message: string | null) => void;
  setQuerySettings: (settings: QuerySettings) => void;
  setFormatterSettings: (settings: FormatterSettings) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  querySettings: loadQuerySettings(),
  formatterSettings: loadSettings(),
  updateStatus: "idle",
  updateVersion: null,
  updateError: null,
  pendingUpdate: null,

  checkForUpdates: async () => {
    set({ updateStatus: "checking", updateError: null });
    try {
      const update = await check();
      if (update) {
        set({
          updateStatus: "available",
          updateVersion: update.version,
          pendingUpdate: update,
        });
      } else {
        set({
          updateStatus: "up-to-date",
          updateVersion: null,
          pendingUpdate: null,
        });
      }
    } catch (e) {
      console.error("Update check failed:", e);
      set({
        updateStatus: "error",
        updateVersion: null,
        pendingUpdate: null,
        updateError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  installUpdate: async () => {
    set({ updateStatus: "downloading", updateError: null });
    try {
      const cached = useSettingsStore.getState().pendingUpdate;
      if (!cached) return;
      await cached.downloadAndInstall();
      set({ updateStatus: "downloaded" });
      await relaunch();
    } catch (e) {
      console.error("Update install failed:", e);
      set({
        updateStatus: "error",
        updateError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  setUpdateError: (message) => set({ updateError: message }),

  setQuerySettings: (settings) => {
    try {
      localStorage.setItem(QUERY_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // localStorage unavailable
    }
    set({ querySettings: settings });
  },

  setFormatterSettings: (settings) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // localStorage unavailable
    }
    set({ formatterSettings: settings });
  },
}));
