import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface HistoryEntry {
  id: string;
  sql: string;
  connectionName: string;
  database?: string;
  executedAt: string;
  executionTimeMs: number;
  rowCount: number;
  status: "success" | "error";
  /** What went wrong, for a failed entry. Shown inline in the panel. */
  error?: string;
  /**
   * The driver's own error number where it gave one — MySQL's code, SQLite's
   * extended result code. Kept beside the message so a user scanning history
   * can tell a missing table (1146) from a syntax error (1064) without
   * rerunning the query (#324).
   */
  errorCode?: number;
  /** SQLSTATE, where the driver supplies one. MySQL does; SQLite does not. */
  errorSqlState?: string;
}

interface HistoryState {
  entries: HistoryEntry[];
  addEntry: (entry: HistoryEntry) => void;
  removeEntry: (id: string) => void;
  clearHistory: () => void;
}

const MAX_ENTRIES = 500;

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set) => ({
      entries: [],

      addEntry: (entry) =>
        set((state) => ({
          entries: [entry, ...state.entries].slice(0, MAX_ENTRIES),
        })),

      removeEntry: (id) =>
        set((state) => ({
          entries: state.entries.filter((e) => e.id !== id),
        })),

      clearHistory: () => set({ entries: [] }),
    }),
    { name: "mas-query-history" },
  ),
);
