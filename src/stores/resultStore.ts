import { create } from "zustand";
import type { QueryResult } from "../types";
import { api } from "../lib/tauri-api";
import { useHistoryStore } from "./historyStore";
import { useConnectionStore } from "./connectionStore";

const DESTRUCTIVE_PATTERN =
  /\b(DROP|DELETE|TRUNCATE|ALTER)\b/i;

interface ConfirmDialogState {
  isOpen: boolean;
  connectionId: string;
  sql: string;
  database?: string;
}

interface ResultState {
  results: QueryResult[];
  activeResultIndex: number;
  isExecuting: boolean;
  error: string | null;

  explainResult: QueryResult | null;
  explainAnalyze: boolean;
  showExplain: boolean;

  confirmDialog: ConfirmDialogState | null;

  executeQuery: (connectionId: string, sql: string, database?: string) => Promise<void>;
  executeExplain: (connectionId: string, sql: string, database?: string) => Promise<void>;
  executeExplainAnalyze: (connectionId: string, sql: string, database?: string) => Promise<void>;
  setActiveResult: (index: number) => void;
  setShowExplain: (show: boolean) => void;
  clearResults: () => void;
  clearError: () => void;
  confirmExecution: () => void;
  cancelExecution: () => void;
}

function isProductionConnection(connectionId: string): boolean {
  const state = useConnectionStore.getState();
  const conn = state.activeConnections.find((c) => c.id === connectionId);
  if (!conn) return false;
  const profile = state.profiles.find((p) => p.id === conn.profile_id);
  return profile?.environment === "production";
}

export const useResultStore = create<ResultState>((set, get) => ({
  results: [],
  activeResultIndex: 0,
  isExecuting: false,
  error: null,

  explainResult: null,
  explainAnalyze: false,
  showExplain: false,

  confirmDialog: null,

  executeQuery: async (connectionId, sql, database) => {
    // Production safety check
    if (isProductionConnection(connectionId) && DESTRUCTIVE_PATTERN.test(sql)) {
      set({ confirmDialog: { isOpen: true, connectionId, sql, database } });
      return;
    }
    await doExecuteQuery(connectionId, sql, set, database);
  },

  confirmExecution: async () => {
    const dialog = get().confirmDialog;
    if (!dialog) return;
    set({ confirmDialog: null });
    await doExecuteQuery(dialog.connectionId, dialog.sql, set, dialog.database);
  },

  cancelExecution: () => {
    set({ confirmDialog: null });
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

  executeExplain: async (connectionId, sql, database) => {
    try {
      set({ isExecuting: true, error: null });
      const results = await api.executeQuery(
        connectionId,
        `EXPLAIN ${sql}`,
        database,
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

  executeExplainAnalyze: async (connectionId, sql, database) => {
    try {
      set({ isExecuting: true, error: null });
      const results = await api.executeQuery(
        connectionId,
        `EXPLAIN ANALYZE ${sql}`,
        database,
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

async function doExecuteQuery(
  connectionId: string,
  sql: string,
  set: (partial: Partial<ResultState>) => void,
  database?: string,
) {
  const startTime = Date.now();
  const connState = useConnectionStore.getState();
  const conn = connState.activeConnections.find(
    (c) => c.id === connectionId,
  );
  const connectionName = conn?.name ?? "Unknown";
  // Explicit database selection takes precedence over the connection's default
  const effectiveDatabase = database ?? conn?.database;

  try {
    set({ isExecuting: true, error: null });
    const results = await api.executeQuery(connectionId, sql, effectiveDatabase);
    set({ results, activeResultIndex: 0, isExecuting: false });

    const totalRows = results.reduce((sum, r) => sum + r.rows.length, 0);
    useHistoryStore.getState().addEntry({
      id: crypto.randomUUID(),
      sql,
      connectionName,
      database: effectiveDatabase,
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
      database: effectiveDatabase,
      executedAt: new Date().toISOString(),
      executionTimeMs: Date.now() - startTime,
      rowCount: 0,
      status: "error",
      error: String(e),
    });
  }
}
