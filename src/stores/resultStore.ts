import { create } from "zustand";
import { api } from "../lib/tauri-api";
import type { QueryResult } from "../types";
import { useConnectionStore } from "./connectionStore";
import { useHistoryStore } from "./historyStore";
import { useSettingsStore } from "./settingsStore";

const DESTRUCTIVE_PATTERN = /\b(DROP|DELETE|TRUNCATE|ALTER)\b/i;

/**
 * What the pending confirmation would run if approved. `explain-analyze` is
 * confirmed separately from `query` because it is gated on the connection being
 * production, not on the statement being destructive — ANALYZE executes even a
 * plain SELECT, and on production that alone is worth a prompt (#412).
 */
export type PendingKind = "query" | "explain-analyze";

interface ConfirmDialogState {
  isOpen: boolean;
  kind: PendingKind;
  connectionId: string;
  sql: string;
  database?: string;
}

/** Why the backend declined to ANALYZE, in words the user can act on. */
const REFUSAL_COPY: Record<string, string> = {
  would_mutate:
    "EXPLAIN ANALYZE executes the statement, which would apply this write — showing the plan from EXPLAIN instead.",
  read_only_connection:
    "This connection is marked read-only and EXPLAIN ANALYZE executes the statement — showing the plan from EXPLAIN instead.",
};

interface ResultState {
  results: QueryResult[];
  activeResultIndex: number;
  isExecuting: boolean;
  error: string | null;

  explainResult: QueryResult | null;
  explainAnalyze: boolean;
  /**
   * True when the plan came back in tabular shape. MariaDB's ANALYZE answers
   * with the same 12 columns as EXPLAIN, so it belongs in the table/tree views;
   * only MySQL's single-column TREE text belongs in the raw-text view (#422).
   */
  explainTabular: boolean;
  /** Set when ANALYZE was requested but downgraded — shown above the plan. */
  explainNotice: string | null;
  showExplain: boolean;

  confirmDialog: ConfirmDialogState | null;

  executeQuery: (connectionId: string, sql: string, database?: string) => Promise<void>;
  executeExplain: (connectionId: string, sql: string, database?: string) => Promise<void>;
  executeExplainAnalyze: (connectionId: string, sql: string, database?: string) => Promise<void>;
  cancelActiveQuery: () => Promise<void>;
  setActiveResult: (index: number) => void;
  setShowExplain: (show: boolean) => void;
  clearResults: () => void;
  clearError: () => void;
  confirmExecution: () => void;
  cancelExecution: () => void;
}

let cancelGeneration = 0;

/**
 * Connection the in-flight statement is running on, so cancel knows which
 * server-side thread to KILL. Module-level rather than store state because it
 * is bookkeeping, not something a component renders.
 */
let executingConnectionId: string | null = null;

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
  explainTabular: false,
  explainNotice: null,
  showExplain: false,

  confirmDialog: null,

  executeQuery: async (connectionId, sql, database) => {
    // Production safety check
    if (isProductionConnection(connectionId) && DESTRUCTIVE_PATTERN.test(sql)) {
      set({ confirmDialog: { isOpen: true, kind: "query", connectionId, sql, database } });
      return;
    }
    await doExecuteQuery(connectionId, sql, set, database);
  },

  confirmExecution: async () => {
    const dialog = get().confirmDialog;
    if (!dialog) return;
    set({ confirmDialog: null });
    if (dialog.kind === "explain-analyze") {
      await doExplain(dialog.connectionId, dialog.sql, true, set, dialog.database);
      return;
    }
    await doExecuteQuery(dialog.connectionId, dialog.sql, set, dialog.database);
  },

  cancelExecution: () => {
    set({ confirmDialog: null });
  },

  cancelActiveQuery: async () => {
    // Bumping the generation only makes this client ignore the response. The
    // statement keeps running — and holding locks — until the server is told to
    // stop, which is what cancelQuery does (#420).
    cancelGeneration++;
    const connectionId = executingConnectionId;
    set({ isExecuting: false, error: "Query cancelled by user" });
    if (!connectionId) return;
    try {
      await api.cancelQuery(connectionId);
    } catch (e) {
      set({ error: `Query cancelled, but the server did not confirm: ${String(e)}` });
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
      explainNotice: null,
      showExplain: false,
    }),
  clearError: () => set({ error: null }),

  executeExplain: async (connectionId, sql, database) => {
    await doExplain(connectionId, sql, false, set, database);
  },

  executeExplainAnalyze: async (connectionId, sql, database) => {
    // ANALYZE really runs the statement. The backend downgrades writes on its
    // own; production gets a prompt even for a read, because the cost is real.
    if (isProductionConnection(connectionId)) {
      set({
        confirmDialog: { isOpen: true, kind: "explain-analyze", connectionId, sql, database },
      });
      return;
    }
    await doExplain(connectionId, sql, true, set, database);
  },
}));

async function doExplain(
  connectionId: string,
  sql: string,
  analyze: boolean,
  set: (partial: Partial<ResultState>) => void,
  database?: string,
) {
  try {
    set({ isExecuting: true, error: null, explainNotice: null });
    cancelGeneration++;
    const myGeneration = cancelGeneration;
    executingConnectionId = connectionId;

    // Statement normalization (trailing `;`, multi-statement) and the
    // ANALYZE-safety decision both happen backend-side (#412, #418).
    const response = await api.explainQuery(connectionId, sql, analyze, database);
    if (cancelGeneration !== myGeneration) return;

    set({
      explainResult: response.result,
      explainAnalyze: response.analyzed,
      explainTabular: response.tabular,
      explainNotice: response.refusal ? REFUSAL_COPY[response.refusal] ?? null : null,
      showExplain: true,
      isExecuting: false,
    });
  } catch (e) {
    set({ error: String(e), isExecuting: false });
  } finally {
    executingConnectionId = null;
  }
}

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
  // conn.database is `string | null` from Rust; internal state uses undefined
  const effectiveDatabase = database ?? conn?.database ?? undefined;

  // Compute row limit from settings
  const { limitEnabled, maxResultRows } = useSettingsStore.getState().querySettings;
  const rowLimit = limitEnabled ? maxResultRows : undefined;

  try {
    set({ isExecuting: true, error: null });
    cancelGeneration++;
    const myGeneration = cancelGeneration;
    executingConnectionId = connectionId;
    const results = await api.executeQuery(connectionId, sql, effectiveDatabase, rowLimit);
    if (cancelGeneration !== myGeneration) return;
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
  } finally {
    executingConnectionId = null;
  }
}
