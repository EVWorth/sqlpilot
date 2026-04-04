import { create } from "zustand";
import type { QueryResult } from "../types";
import { api } from "../lib/tauri-api";
import { useHistoryStore } from "./historyStore";
import { useConnectionStore } from "./connectionStore";

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
    const startTime = Date.now();
    const connState = useConnectionStore.getState();
    const conn = connState.activeConnections.find(
      (c) => c.id === connectionId,
    );
    const connectionName = conn?.name ?? "Unknown";
    const database = conn?.database;

    try {
      set({ isExecuting: true, error: null });
      const results = await api.executeQuery(connectionId, sql);
      set({ results, activeResultIndex: 0, isExecuting: false });

      const totalRows = results.reduce((sum, r) => sum + r.rows.length, 0);
      useHistoryStore.getState().addEntry({
        id: crypto.randomUUID(),
        sql,
        connectionName,
        database,
        executedAt: new Date().toISOString(),
        executionTimeMs: Date.now() - startTime,
        rowCount: totalRows,
        status: "success",
      });
    } catch (e) {
      set({ error: String(e), isExecuting: false, results: [] });

      useHistoryStore.getState().addEntry({
        id: crypto.randomUUID(),
        sql,
        connectionName,
        database,
        executedAt: new Date().toISOString(),
        executionTimeMs: Date.now() - startTime,
        rowCount: 0,
        status: "error",
        error: String(e),
      });
    }
  },

  setActiveResult: (index) => set({ activeResultIndex: index }),
  clearResults: () => set({ results: [], activeResultIndex: 0, error: null }),
  clearError: () => set({ error: null }),
}));
