import { create } from "zustand";
import type { QueryResult } from "../types";
import { api } from "../lib/tauri-api";

interface ResultState {
  results: QueryResult[];
  activeResultIndex: number;
  isExecuting: boolean;
  error: string | null;

  executeQuery: (connectionId: string, sql: string) => Promise<void>;
  setActiveResult: (index: number) => void;
  clearResults: () => void;
  clearError: () => void;
}

export const useResultStore = create<ResultState>((set) => ({
  results: [],
  activeResultIndex: 0,
  isExecuting: false,
  error: null,

  executeQuery: async (connectionId, sql) => {
    try {
      set({ isExecuting: true, error: null });
      const results = await api.executeQuery(connectionId, sql);
      set({ results, activeResultIndex: 0, isExecuting: false });
    } catch (e) {
      set({ error: String(e), isExecuting: false, results: [] });
    }
  },

  setActiveResult: (index) => set({ activeResultIndex: index }),
  clearResults: () => set({ results: [], activeResultIndex: 0, error: null }),
  clearError: () => set({ error: null }),
}));
