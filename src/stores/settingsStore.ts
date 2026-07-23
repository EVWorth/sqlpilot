import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { api } from "../lib/tauri-api";

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

interface DownloadProgress {
  transferred: number;
  total: number | null;
}

interface SettingsState {
  querySettings: QuerySettings;
  formatterSettings: FormatterSettings;
  updateStatus:
    | "idle"
    | "checking"
    | "available"
    | "manual-update-required"
    | "downloading"
    | "downloaded"
    | "up-to-date"
    | "error";
  updateVersion: string | null;
  updateError: string | null;
  pendingUpdate: Update | null;
  manualUpdateCommand: string | null;
  platformHint: "standard" | "rpm-ostree" | "unknown";
  downloadProgress: DownloadProgress;
  detectPlatform: () => Promise<void>;
  checkForUpdates: () => Promise<void>;
  installUpdate: () => Promise<void>;
  setUpdateError: (message: string | null) => void;
  setQuerySettings: (settings: QuerySettings) => void;
  setFormatterSettings: (settings: FormatterSettings) => void;
}

// Tauri-action's .rpm filename uses period before arch:
// `SQLPilot-0.4.0-1.x86_64.rpm`. If tauri-action ever changes this pattern,
// this template must follow. See docs/RELEASING.md gotcha #3.
function buildRpmUrl(version: string): string {
  return `https://github.com/EVWorth/sqlpilot/releases/download/v${version}/SQLPilot-${version}-1.x86_64.rpm`;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  querySettings: loadQuerySettings(),
  formatterSettings: loadSettings(),
  updateStatus: "idle",
  updateVersion: null,
  updateError: null,
  pendingUpdate: null,
  manualUpdateCommand: null,
  platformHint: "unknown",
  downloadProgress: { transferred: 0, total: null },

  detectPlatform: async () => {
    try {
      const isRpmOstree = await api.isRpmOstree();
      set({ platformHint: isRpmOstree ? "rpm-ostree" : "standard" });
    } catch (e) {
      console.error("Failed to detect platform:", e);
      set({ platformHint: "unknown" });
    }
  },

  checkForUpdates: async () => {
    set({ updateStatus: "checking", updateError: null, manualUpdateCommand: null });
    try {
      const update = await check();
      if (update) {
        if (get().platformHint === "rpm-ostree") {
          set({
            updateStatus: "manual-update-required",
            updateVersion: update.version,
            pendingUpdate: null,
            manualUpdateCommand: `rpm-ostree install ${buildRpmUrl(update.version)}`,
          });
        } else {
          set({
            updateStatus: "available",
            updateVersion: update.version,
            pendingUpdate: update,
          });
        }
      } else {
        set({
          updateStatus: "up-to-date",
          updateVersion: null,
          pendingUpdate: null,
          manualUpdateCommand: null,
        });
      }
    } catch (e) {
      console.error("Update check failed:", e);
      set({
        updateStatus: "error",
        updateVersion: null,
        pendingUpdate: null,
        manualUpdateCommand: null,
        updateError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  installUpdate: async () => {
    set({
      updateStatus: "downloading",
      updateError: null,
      downloadProgress: { transferred: 0, total: null },
    });
    try {
      const cached = useSettingsStore.getState().pendingUpdate;
      if (!cached) return;
      await cached.downloadAndInstall((event) => {
        const data = (event as { data?: { contentLength?: number; chunkLength?: number } }).data;
        if (event.event === "Started" && data?.contentLength != null) {
          set({ downloadProgress: { transferred: 0, total: data.contentLength } });
        } else if (event.event === "Progress" && data?.chunkLength != null) {
          const chunk = data.chunkLength;
          set((s) => ({
            downloadProgress: {
              transferred: s.downloadProgress.transferred + chunk,
              total: s.downloadProgress.total,
            },
          }));
        }
      });
      set({ updateStatus: "downloaded" });
      await relaunch();
    } catch (e) {
      console.error("Update install failed:", e);
      set({
        updateStatus: "error",
        updateError: e instanceof Error ? e.message : String(e),
        downloadProgress: { transferred: 0, total: null },
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
