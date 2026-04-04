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
  error?: string;
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
