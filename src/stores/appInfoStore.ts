import { create } from "zustand";
import type { StartupProblem } from "../lib/bindings";
import { api } from "../lib/tauri-api";

/**
 * Facts about the running app that the status bar and the About tab show
 * (#862): its version, whether the OS keyring answers, and what the backend
 * could not do before the window existed.
 *
 * None of these failing says anything the user can act on, so a failed read
 * is logged and leaves the value as it was rather than raising an error.
 */
interface AppInfoState {
  /** Empty until read. */
  appVersion: string;
  /**
   * Undefined until the check answers; only `false` means a missing keyring,
   * so a slow reply never flashes a warning at someone whose keyring is fine.
   */
  keyringAvailable: boolean | undefined;
  /**
   * No saved connections, no history, a data folder that will not persist.
   * These used to be panics, which meant the process vanished and the user
   * saw nothing at all.
   */
  startupProblems: StartupProblem[];

  loadAppVersion: () => Promise<void>;
  checkKeyring: () => Promise<void>;
  loadStartupProblems: () => Promise<void>;
}

export const useAppInfoStore = create<AppInfoState>((set) => ({
  appVersion: "",
  keyringAvailable: undefined,
  startupProblems: [],

  loadAppVersion: async () => {
    try {
      set({ appVersion: await api.getAppVersion() });
    } catch (e) {
      console.error("Failed to get app version", e);
    }
  },

  checkKeyring: async () => {
    try {
      set({ keyringAvailable: await api.keyringAvailable() });
    } catch {
      // The check itself failing says nothing about the keyring; stay quiet.
    }
  },

  loadStartupProblems: async () => {
    try {
      set({ startupProblems: await api.startupProblems() });
    } catch (e) {
      // The report failing to arrive says nothing about the app's state.
      console.warn("Could not read the startup report", e);
    }
  },
}));
