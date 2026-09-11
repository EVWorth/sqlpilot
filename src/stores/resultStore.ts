import { create } from "zustand";
import { connectionKind, dataSourceFor } from "../lib/datasource";
import { isDestructiveStatement } from "../lib/sql-safety";
import { api, CommandError } from "../lib/tauri-api";
import type { QueryResult } from "../types";
import { useConnectionStore } from "./connectionStore";
import { useHistoryStore } from "./historyStore";
import { isProductionConnection } from "./productionGuardStore";
import { useSettingsStore } from "./settingsStore";

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

/**
 * Which page of a truncated result is on screen.
 *
 * FR-3.1.8. The row limit is a hard stop, not a window: a user whose query
 * matched a million rows saw the first 1000 and had no way to reach row 1001
 * short of editing the SQL (#391). Paging re-runs the statement and discards
 * rows on the way in, which works on SHOW output and on the result sets a
 * procedure returns — neither of which an OFFSET can reach.
 */
interface PageState {
  /** The statement being paged, so a new query resets the page. */
  sql: string;
  connectionId: string;
  database?: string;
  /** 0-based. */
  index: number;
  size: number;
  /** False once a page comes back short, which is how the end is recognised. */
  hasMore: boolean;
}

interface ResultState {
  results: QueryResult[];
  activeResultIndex: number;
  isExecuting: boolean;
  error: string | null;
  /** Null when the result fitted inside the row limit, so paging is moot. */
  page: PageState | null;

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
  /** Fetch another page of the statement currently on screen. */
  goToPage: (index: number) => Promise<void>;
  setShowExplain: (show: boolean) => void;
  clearResults: () => void;
  clearError: () => void;
  confirmExecution: () => void;
  cancelExecution: () => void;
}

let cancelGeneration = 0;

/**
 * The execution cancel would act on, so it knows which connection to tell the
 * server about. Module-level rather than store state because it is bookkeeping,
 * not something a component renders.
 *
 * Tagged with the generation that opened it: a slower execution finishing must
 * not clear the entry a newer one has already installed, or cancel would find
 * nothing and silently leave the query running.
 */
let activeExecution: { generation: number; connectionId: string } | null = null;

/** Release the slot only if this execution still owns it. */
function endExecution(generation: number) {
  if (activeExecution?.generation === generation) activeExecution = null;
}

export const useResultStore = create<ResultState>((set, get) => ({
  results: [],
  activeResultIndex: 0,
  isExecuting: false,
  error: null,
  page: null,

  explainResult: null,
  explainAnalyze: false,
  explainTabular: false,
  explainNotice: null,
  showExplain: false,

  confirmDialog: null,

  executeQuery: async (connectionId, sql, database) => {
    // Production safety check
    if (isProductionConnection(connectionId) && isDestructiveStatement(sql)) {
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
    const myGeneration = cancelGeneration;
    const connectionId = activeExecution?.connectionId ?? null;
    activeExecution = null;
    set({ isExecuting: false, error: "Query cancelled by user" });
    if (!connectionId) return;
    try {
      await api.cancelQuery(connectionId);
    } catch (e) {
      // Only while this cancel is still what the user is looking at. Telling
      // the server to stop can outlast the query it was about, and reporting
      // its failure over a query that started since would replace that
      // query's state with a message about one already gone (#287).
      if (cancelGeneration !== myGeneration) return;
      set({ error: `Query cancelled, but the server did not confirm: ${String(e)}` });
    }
  },

  setActiveResult: (index) => set({ activeResultIndex: index }),

  goToPage: async (index) => {
    const page = get().page;
    if (!page || index < 0 || index === page.index) return;
    await doExecuteQuery(page.connectionId, page.sql, set, page.database, {
      index,
      size: page.size,
    });
  },
  setShowExplain: (show) => set({ showExplain: show }),
  clearResults: () =>
    set({
      results: [],
      activeResultIndex: 0,
      error: null,
      page: null,
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
  // The explain command is MySQL-only. Saying so beats letting the backend
  // answer "connection not found", which describes an internal detail rather
  // than the situation.
  if (connectionKind(connectionId) !== "mysql") {
    set({ error: "Query plans are not available for SQLite connections yet." });
    return;
  }

  cancelGeneration++;
  const myGeneration = cancelGeneration;
  activeExecution = { generation: myGeneration, connectionId };

  try {
    set({ isExecuting: true, error: null, explainNotice: null });

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
    // A cancel kills the statement server-side, so the in-flight call rejects
    // with the server's interrupt error. Reporting it would overwrite the
    // "cancelled" message the user just asked for.
    if (cancelGeneration !== myGeneration) return;
    set({ error: String(e), isExecuting: false });
  } finally {
    endExecution(myGeneration);
  }
}

async function doExecuteQuery(
  connectionId: string,
  sql: string,
  set: (partial: Partial<ResultState>) => void,
  database?: string,
  /** Set when this run is a page change rather than a fresh execution. */
  paging?: { index: number; size: number },
) {
  const startTime = Date.now();
  const connState = useConnectionStore.getState();
  const conn = connState.activeConnections.find(
    (c) => c.id === connectionId,
  );
  // A missing `conn` means the id is not in activeConnections at the moment
  // the statement starts. See the two history writes below for what that
  // means for each outcome (#328).
  const connectionName = conn?.name ?? "Unknown connection";
  // Explicit database selection takes precedence over the connection's default
  // conn.database is `string | null` from Rust; internal state uses undefined
  const effectiveDatabase = database ?? conn?.database ?? undefined;

  // Compute row limit from settings
  const { limitEnabled, maxResultRows } = useSettingsStore.getState().querySettings;
  // Paging carries its own size so a settings change mid-session cannot leave
  // page 3 starting at a different row than page 2 ended.
  const rowLimit = paging?.size ?? (limitEnabled ? maxResultRows : undefined);
  const offset = paging ? paging.index * paging.size : undefined;

  cancelGeneration++;
  const myGeneration = cancelGeneration;
  activeExecution = { generation: myGeneration, connectionId };

  try {
    set({ isExecuting: true, error: null });
    // Through the data source, so the editor runs a statement the same way
    // whichever backend the connection belongs to (#461).
    const results = await dataSourceFor(connectionId).execute(
      connectionId,
      sql,
      effectiveDatabase,
      rowLimit,
      offset,
    );
    if (cancelGeneration !== myGeneration) return;

    // Paging is offered only where a page actually filled up. A result that
    // came back short is the whole answer, and page controls on it would
    // invite a second round trip to fetch nothing.
    const filled = rowLimit !== undefined
      && results.some((r) => r.rows.length >= rowLimit);
    const pageIndex = paging?.index ?? 0;
    set({
      results,
      activeResultIndex: 0,
      isExecuting: false,
      page: rowLimit !== undefined && (filled || pageIndex > 0)
        ? {
          sql,
          connectionId,
          database: effectiveDatabase,
          index: pageIndex,
          size: rowLimit,
          hasMore: filled,
        }
        : null,
    });

    if (!conn) {
      // The statement ran and succeeded, so it is a real record and worth
      // keeping even unattributed — but the frontend's connection list
      // disagreeing with the backend's is a bug in its own right, and a
      // silent "Unknown connection" row is how it stayed invisible (#328).
      console.warn(
        `Recorded a successful query against ${connectionId}, which is not in activeConnections`,
      );
    }

    // One entry per statement, not one per run. A script whose third statement
    // failed used to show as one opaque row, with no way to tell which line to
    // look at (#329). Each result carries the statement it came from, so the
    // pairing is the backend's rather than a second splitter to keep in step.
    // A page change re-runs the same statement, so recording it again would
    // fill history with one row per Next click for a query the user ran once.
    if (paging) return;

    const recordedAt = new Date().toISOString();
    const elapsed = Date.now() - startTime;
    for (const result of results) {
      void useHistoryStore.getState().addEntry({
        id: crypto.randomUUID(),
        // A backend too old to send the statement text falls back to the whole
        // script, which is what the panel showed before this.
        sql: result.sql || sql,
        connectionName,
        // Rust's Option round-trips as null, so an absent field is null here
        // rather than undefined.
        database: effectiveDatabase ?? null,
        executedAt: recordedAt,
        // The batch's total. Per-statement timings are not measured
        // separately, and inventing a split would be worse than repeating the
        // one number that is true.
        executionTimeMs: elapsed,
        rowCount: result.rows.length,
        status: "success",
        error: null,
        errorCode: null,
        errorSqlState: null,
        origin: "editor",
      });
    }
  } catch (e) {
    // A cancel kills the statement server-side, so this rejects with the
    // server's interrupt error. Reporting it would replace the "cancelled"
    // message with a raw database error and log the user's own cancellation
    // to history as a failed query.
    if (cancelGeneration !== myGeneration) return;
    set({ error: String(e), isExecuting: false, results: [], page: null });

    // The driver's code and SQLSTATE ride along where it supplied them, so the
    // history panel can say which failure this was (#324).
    const structured = e instanceof CommandError ? e : undefined;

    // Nothing to remember. Without a connection the statement never reached a
    // server, so the entry would record an attempt rather than a query — and
    // fifty rows saying "Unknown connection" are fifty rows a user cannot act
    // on or trace back to anything (#328).
    // `finally` below still releases the execution slot.
    if (!conn) return;

    void useHistoryStore.getState().addEntry({
      id: crypto.randomUUID(),
      sql,
      connectionName,
      database: effectiveDatabase ?? null,
      executedAt: new Date().toISOString(),
      executionTimeMs: Date.now() - startTime,
      rowCount: 0,
      status: "error",
      error: structured?.message ?? String(e),
      errorCode: structured?.code ?? null,
      errorSqlState: structured?.sqlState ?? null,
      origin: "editor",
    });
  } finally {
    endExecution(myGeneration);
  }
}
