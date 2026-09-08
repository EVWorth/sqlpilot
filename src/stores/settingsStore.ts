import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import type { PackageFormat } from "../lib/bindings";
import { api } from "../lib/tauri-api";
import { canSelfUpdate, manualUpdateFor } from "../lib/update-channel";
import { describeUpdateBlockers } from "../lib/update-guard";
import { type StorageErrorKey, useStorageErrorStore } from "./storageErrorStore";

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
  /**
   * A version the user asked not to be reminded about, for this session.
   *
   * Stored as the version rather than a flag, so a newer one still surfaces —
   * "later" means later for this update, not silence for every update. Not
   * persisted: a dismissal should not outlive the run it was made in (#353).
   */
  dismissedVersion: string | null;
  /** How this copy was installed; null until detected, or if detection failed. */
  packageFormat: PackageFormat | null;
  arch: string | null;
  downloadProgress: DownloadProgress;
  detectPlatform: () => Promise<void>;
  /** `force` is the user asking; anything automatic should omit it. */
  checkForUpdates: (force?: boolean) => Promise<void>;
  installUpdate: () => Promise<void>;
  restartToApply: () => Promise<void>;
  dismissUpdate: () => void;
  setUpdateError: (message: string | null) => void;
  setQuerySettings: (settings: QuerySettings) => void;
  setFormatterSettings: (settings: FormatterSettings) => void;
}

// Tauri-action's .rpm filename uses period before arch:
// `SQLPilot-0.4.0-1.x86_64.rpm`. If tauri-action ever changes this pattern,
// this template must follow. See docs/RELEASING.md gotcha #3.
/**
 * Write one settings blob to localStorage, routing any failure to the shared
 * storage-error store so the StatusBar can show it. Quota exhaustion or a
 * blocked store would otherwise revert the user's settings on next launch
 * with no signal at all. (refs #454)
 */
function persist(
  storageKey: string,
  value: unknown,
  errorKey: StorageErrorKey,
  label: string,
): void {
  const { reportStorageError } = useStorageErrorStore.getState();
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
    reportStorageError(errorKey, null, label);
  } catch (e) {
    reportStorageError(errorKey, e, label);
  }
}

/** How long an automatic check waits before asking GitHub again. */
const CHECK_INTERVAL_MS = 60_000;

/**
 * Module-level rather than store state: bookkeeping, not something rendered.
 * Tests get a clean pair from `vi.resetModules()`, so no reset seam is needed
 * in the store itself.
 */
let checkInFlight = false;
let lastCheckAt: number | null = null;

export const useSettingsStore = create<SettingsState>((set, get) => ({
  querySettings: loadQuerySettings(),
  formatterSettings: loadSettings(),
  updateStatus: "idle",
  updateVersion: null,
  updateError: null,
  pendingUpdate: null,
  manualUpdateCommand: null,
  dismissedVersion: null,
  packageFormat: null,
  arch: null,
  downloadProgress: { transferred: 0, total: null },

  detectPlatform: async () => {
    try {
      const info = await api.getPlatformInfo();
      set({ packageFormat: info.package_format, arch: info.arch });
    } catch (e) {
      console.error("Failed to detect platform:", e);
      // Unknown means "do not offer to update", which is the safe direction:
      // an update the app cannot apply is worse than one it does not offer.
      set({ packageFormat: null, arch: null });
    }
  },

  checkForUpdates: async (force = false) => {
    // A check that lands mid-install would overwrite "downloading" with
    // "available" and take the progress display away from a download that is
    // still running. Nothing automatic should interrupt an install in flight
    // (#347).
    const status = get().updateStatus;
    if (status === "downloading" || status === "downloaded") return;

    // One at a time, and not more than once a minute unless asked. The status
    // bar re-runs this whenever the status returns to idle, which a store
    // reset or a hot reload also does — each one was a request to GitHub
    // (#346). The user's own button passes force and is never skipped.
    if (!force) {
      if (checkInFlight) return;
      if (lastCheckAt !== null && Date.now() - lastCheckAt < CHECK_INTERVAL_MS) return;
    }
    if (checkInFlight) return;

    checkInFlight = true;
    lastCheckAt = Date.now();
    set({ updateStatus: "checking", updateError: null, manualUpdateCommand: null });
    try {
      const update = await check();
      if (update) {
        const format = get().packageFormat;
        const manual = format
          ? manualUpdateFor(format, update.version, get().arch ?? "x86_64")
          : null;
        if (manual || (format !== null && !canSelfUpdate(format))) {
          set({
            updateStatus: "manual-update-required",
            updateVersion: update.version,
            pendingUpdate: null,
            manualUpdateCommand: manual?.command ?? null,
            updateError: manual?.reason ?? null,
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
    } finally {
      checkInFlight = false;
    }
  },

  installUpdate: async () => {
    // The refusal lives here rather than in the button that calls it, so a
    // second caller cannot arrive without it (#570).
    const blocked = describeUpdateBlockers();
    if (blocked) {
      set({ updateStatus: "error", updateError: blocked });
      return;
    }

    const cached = useSettingsStore.getState().pendingUpdate;
    if (!cached) {
      // Nothing to install — most likely a check that resolved between the
      // click and this read and cleared it. Saying so beats leaving the
      // status bar reporting a download that is not happening (#569).
      set({
        updateStatus: "error",
        updateError: "The pending update is no longer available. Check for updates again.",
      });
      return;
    }

    // Pinned for the duration. A check that resolves mid-download would
    // otherwise leave the UI naming a different version than the one being
    // installed (#347).
    const installingVersion = cached.version;
    set({
      updateStatus: "downloading",
      updateVersion: installingVersion,
      updateError: null,
      downloadProgress: { transferred: 0, total: null },
    });
    try {
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
      // Downloaded and staged, but not applied. Restarting is a separate act
      // the user chooses, because it closes the app: the checks above ran
      // before a download that can take minutes, and the state they looked at
      // may not be the state now (#344, #570).
      set({ updateStatus: "downloaded", updateVersion: installingVersion });
    } catch (e) {
      console.error("Update install failed:", e);
      set({
        updateStatus: "error",
        updateError: e instanceof Error ? e.message : String(e),
        downloadProgress: { transferred: 0, total: null },
      });
    }
  },

  restartToApply: async () => {
    // Checked again, at the moment it matters. A query started or a tab
    // edited during the download would otherwise be destroyed by a restart
    // authorised minutes earlier.
    const blocked = describeUpdateBlockers();
    if (blocked) {
      set({ updateStatus: "error", updateError: blocked });
      return;
    }
    try {
      await relaunch();
    } catch (e) {
      console.error("Relaunch failed:", e);
      // The update is on disk either way, so say that rather than implying
      // it needs downloading again.
      set({
        updateStatus: "error",
        updateError: `The update is installed but the app could not restart itself: ${
          e instanceof Error ? e.message : String(e)
        }. Quit and reopen SQLPilot to finish.`,
      });
    }
  },

  dismissUpdate: () => {
    const version = get().updateVersion;
    if (version) set({ dismissedVersion: version });
  },

  setUpdateError: (message) => set({ updateError: message }),

  setQuerySettings: (settings) => {
    persist(QUERY_SETTINGS_KEY, settings, "query-settings", "query settings");
    set({ querySettings: settings });
  },

  setFormatterSettings: (settings) => {
    persist(STORAGE_KEY, settings, "formatter-settings", "formatter settings");
    set({ formatterSettings: settings });
  },
}));
