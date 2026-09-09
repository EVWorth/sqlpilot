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
  /** How many entries to keep. One of {@link HISTORY_LIMITS}. */
  limit: number;
  addEntry: (entry: HistoryEntry) => void;
  removeEntry: (id: string) => void;
  clearHistory: () => void;
  setLimit: (limit: number) => void;
}

/**
 * How many queries the history keeps.
 *
 * The spec asked for 10,000 and the architecture note said 200, while the code
 * kept 500 with no way to change it — three numbers, none of them agreeing,
 * and the user could not pick any of them (#323). 500 is the default because
 * history lives in localStorage, which browsers cap at 5–10 MB per origin for
 * everything the app stores, and a single entry is unbounded in size: one
 * pasted migration script can be tens of kilobytes on its own.
 *
 * Larger settings are offered for people who want them, up to the spec's
 * 10,000, on the understanding that the ceiling is bytes and not entries.
 */
export const DEFAULT_HISTORY_LIMIT = 500;
export const HISTORY_LIMITS = [100, 500, 1000, 5000, 10000] as const;

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set) => ({
      entries: [],
      limit: DEFAULT_HISTORY_LIMIT,

      addEntry: (entry) =>
        set((state) => ({
          entries: [entry, ...state.entries].slice(0, state.limit),
        })),

      removeEntry: (id) =>
        set((state) => ({
          entries: state.entries.filter((e) => e.id !== id),
        })),

      clearHistory: () => set({ entries: [] }),

      // Lowering the limit drops the oldest entries straight away rather than
      // waiting for the next query: the user asked to keep fewer, and a panel
      // still showing 5,000 rows would look like the setting had not taken.
      setLimit: (limit) =>
        set((state) => ({
          limit,
          entries: state.entries.slice(0, limit),
        })),
    }),
    {
      name: "mas-query-history",
      // A stored history from before the limit was configurable has no `limit`
      // field; merge leaves the default in place for it.
      version: 1,
    },
  ),
);
