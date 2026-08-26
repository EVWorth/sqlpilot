import { create } from "zustand";
import { describeStorageError } from "../lib/storage-error";

/**
 * Identifies which persisted thing failed to save. Keyed rather than a single
 * slot so a successful write of one setting cannot clear another's error.
 */
export type StorageErrorKey = "query-settings" | "formatter-settings" | "theme";

interface StorageErrorState {
  errors: Partial<Record<StorageErrorKey, string>>;
  /**
   * Record a failed persist. Pass `null` after a successful write to clear
   * that key. Also logs, so a failure is visible in the console even if the
   * user never looks at the StatusBar.
   */
  reportStorageError: (key: StorageErrorKey, error: unknown | null, label: string) => void;
  dismissStorageError: (key: StorageErrorKey) => void;
}

export const useStorageErrorStore = create<StorageErrorState>((set) => ({
  errors: {},

  reportStorageError: (key, error, label) => {
    if (error === null) {
      set((s) => {
        if (!(key in s.errors)) return s;
        const next = { ...s.errors };
        delete next[key];
        return { errors: next };
      });
      return;
    }
    console.warn(`[storage] could not persist ${label}:`, error);
    set((s) => ({ errors: { ...s.errors, [key]: describeStorageError(error, label) } }));
  },

  dismissStorageError: (key) =>
    set((s) => {
      const next = { ...s.errors };
      delete next[key];
      return { errors: next };
    }),
}));
