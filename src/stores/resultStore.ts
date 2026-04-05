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

  explainResult: QueryResult | null;
  explainAnalyze: boolean;
  showExplain: boolean;

  executeQuery: (connectionId: string, sql: string) => Promise<void>;
  executeExplain: (connectionId: string, sql: string) => Promise<void>;
  executeExplainAnalyze: (connectionId: string, sql: string) => Promise<void>;
  setActiveResult: (index: number) => void;
  setShowExplain: (show: boolean) => void;
  clearResults: () => void;
  clearError: () => void;
}

export const useResultStore = create<ResultState>((set) => ({
  results: [],
  activeResultIndex: 0,
  isExecuting: false,
  error: null,

  explainResult: null,
  explainAnalyze: false,
  showExplain: false,

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
  setShowExplain: (show) => set({ showExplain: show }),
  clearResults: () =>
    set({
      results: [],
      activeResultIndex: 0,
      error: null,
      explainResult: null,
      showExplain: false,
    }),
  clearError: () => set({ error: null }),

  executeExplain: async (connectionId, sql) => {
    try {
      set({ isExecuting: true, error: null });
      const results = await api.executeQuery(
        connectionId,
        `EXPLAIN ${sql}`,
      );
      set({
        explainResult: results[0] ?? null,
        explainAnalyze: false,
        showExplain: true,
        isExecuting: false,
      });
    } catch (e) {
      set({ error: String(e), isExecuting: false });
    }
  },

  executeExplainAnalyze: async (connectionId, sql) => {
    try {
      set({ isExecuting: true, error: null });
      const results = await api.executeQuery(
        connectionId,
        `EXPLAIN ANALYZE ${sql}`,
      );
      set({
        explainResult: results[0] ?? null,
        explainAnalyze: true,
        showExplain: true,
        isExecuting: false,
      });
    } catch (e) {
      set({ error: String(e), isExecuting: false });
    }
  },
}));
