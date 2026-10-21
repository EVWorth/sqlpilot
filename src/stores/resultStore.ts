import { create } from "zustand";
import type { ExplainFormat } from "../lib/bindings";
import { connectionKind, dataSourceFor } from "../lib/datasource";
import { noteSession } from "../lib/server-sessions";
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
  session?: string;
}

/** Why the backend declined to ANALYZE, in words the user can act on. */
const REFUSAL_COPY: Record<string, string> = {
  would_mutate:
    "EXPLAIN ANALYZE executes the statement, which would apply this write — showing the plan from EXPLAIN instead.",
  read_only_connection:
    "This connection is marked read-only and EXPLAIN ANALYZE executes the statement — showing the plan from EXPLAIN instead.",
};

/**
 * Why the plan is not in the format that was asked for.
 *
 * The two servers do not offer the same set, and neither offers every
 * combination with ANALYZE. Saying which one happened beats an error where a
 * plan should be (#424).
 */
const FALLBACK_COPY: Record<string, string> = {
  tree_not_supported: "MariaDB has no tree format — showing the tabular plan instead.",
  analyze_json_not_supported:
    "This MySQL cannot time a JSON plan — showing the plan in JSON, without the actual timings.",
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
  /**
   * The tab's session, so a later page is read where the first one was: a
   * temporary table or a session variable the statement uses exists only
   * there (#731).
   */
  session?: string;
  /** 0-based. */
  index: number;
  size: number;
  /** False once a page comes back short, which is how the end is recognised. */
  hasMore: boolean;
}

/** The connection, database and editor tab session a result was read on. */
export interface ResultSource {
  connectionId: string;
  database?: string;
  /** The editor tab whose session ran the statement; absent off the editor. */
  session?: string;
}

interface ResultState {
  results: QueryResult[];
  activeResultIndex: number;
  isExecuting: boolean;
  /** When the statement on screen started, for the elapsed-time counter. */
  executionStartedAt: number | null;
  error: string | null;
  /**
   * How long the statement had run when the user cancelled it. A cancel is
   * something the user asked for, so it is shown as information rather than
   * as an error (#850). Null unless the last run was cancelled.
   */
  cancelledAfterMs: number | null;
  /** Null when the result fitted inside the row limit, so paging is moot. */
  page: PageState | null;
  /**
   * Where the results on screen were read, so a grid edit to them is saved on
   * the same session and the refresh after it reads from there too (#735).
   * Null when nothing is on screen.
   */
  resultSource: ResultSource | null;

  explainResult: QueryResult | null;
  /** The shape the plan came back in, which decides how it is rendered. */
  explainFormat: ExplainFormat;
  /** What the user asked for, kept so the toolbar stays on their choice. */
  explainRequestedFormat: ExplainFormat;
  /**
   * What was planned last, so the panel can ask for another format without
   * the editor having to hand it the statement again.
   */
  explainRequest: {
    connectionId: string;
    sql: string;
    database?: string;
    analyze: boolean;
    session?: string;
  } | null;
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

  /**
   * The editor tab whose results the top-level fields above hold (#842).
   *
   * Results belong to the tab that ran them. The fields components read are
   * the active tab's; every other tab's are parked in `parked` until it is
   * shown again. Null until the first tab is shown, in which case everything
   * runs into the top-level fields as before.
   */
  viewTabId: string | null;
  /** Every tab but the shown one's results, by tab id. */
  parked: Record<string, TabResultSlice>;
  /** Show this tab's results, parking the ones on screen. */
  showTab: (tabId: string | null) => void;
  /** Drop the results of tabs that have closed. */
  forgetTabs: (liveTabIds: readonly string[]) => void;
  /**
   * Clear what is on screen if it was read on another connection, so a grid
   * from one server is not shown, or offered for editing, under another.
   */
  dropForeignResults: (connectionId: string | null) => void;

  /**
   * `session` is the editor tab running the statement, which keeps it on that
   * tab's own server session (#731). Only the editor passes one; a caller
   * that is not an editor tab leaves it out and runs on the shared pool.
   */
  executeQuery: (connectionId: string, sql: string, database?: string, session?: string) => Promise<void>;
  executeExplain: (
    connectionId: string,
    sql: string,
    database?: string,
    format?: ExplainFormat,
    session?: string,
  ) => Promise<void>;
  executeExplainAnalyze: (
    connectionId: string,
    sql: string,
    database?: string,
    format?: ExplainFormat,
    session?: string,
  ) => Promise<void>;
  cancelActiveQuery: () => Promise<void>;
  setActiveResult: (index: number) => void;
  /** Fetch another page of the statement currently on screen. */
  goToPage: (index: number) => Promise<void>;
  setShowExplain: (show: boolean) => void;
  /** Re-plan the last statement in another format. */
  setExplainFormat: (format: ExplainFormat) => Promise<void>;
  clearResults: () => void;
  clearError: () => void;
  confirmExecution: () => void;
  cancelExecution: () => void;
}

/** The part of the state each editor tab has its own copy of (#842). */
export type TabResultSlice = Pick<
  ResultState,
  | "results"
  | "activeResultIndex"
  | "isExecuting"
  | "executionStartedAt"
  | "error"
  | "cancelledAfterMs"
  | "page"
  | "resultSource"
  | "explainResult"
  | "explainFormat"
  | "explainRequestedFormat"
  | "explainRequest"
  | "explainAnalyze"
  | "explainTabular"
  | "explainNotice"
  | "showExplain"
>;

/** What a tab that has run nothing yet shows. */
const EMPTY_SLICE: TabResultSlice = {
  results: [],
  activeResultIndex: 0,
  isExecuting: false,
  executionStartedAt: null,
  error: null,
  cancelledAfterMs: null,
  page: null,
  resultSource: null,
  explainResult: null,
  explainFormat: "classic",
  explainRequestedFormat: "classic",
  explainRequest: null,
  explainAnalyze: false,
  explainTabular: false,
  explainNotice: null,
  showExplain: false,
};

const SLICE_KEYS = Object.keys(EMPTY_SLICE) as (keyof TabResultSlice)[];

function pickSlice(state: ResultState): TabResultSlice {
  const slice: Record<string, unknown> = {};
  for (const key of SLICE_KEYS) slice[key] = state[key];
  return slice as TabResultSlice;
}

/** The key results from a run without a tab of its own are filed under. */
const NO_TAB = "";

/**
 * Per tab, which run is the current one. A response whose generation is not
 * current any more is ignored: it was cancelled, or the same tab started
 * another run since. Kept per tab so a run in one tab does not discard the
 * response another tab is waiting for (#842).
 */
const generations = new Map<string, number>();

/**
 * Per tab, the execution cancel would act on, so it knows which connection to
 * tell the server about. Module-level rather than store state because it is
 * bookkeeping, not something a component renders.
 *
 * Tagged with the generation that opened it: a slower execution finishing must
 * not clear the entry a newer one has already installed, or cancel would find
 * nothing and silently leave the query running.
 */
const activeExecutions = new Map<string, { generation: number; connectionId: string }>();

/** The tab the last run started in; what cancel acts on before any tab is shown. */
let lastStartedKey = NO_TAB;

function bumpGeneration(key: string): number {
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  return generation;
}

function startExecution(key: string, connectionId: string): number {
  const generation = bumpGeneration(key);
  activeExecutions.set(key, { generation, connectionId });
  lastStartedKey = key;
  return generation;
}

function isCurrent(key: string, generation: number): boolean {
  return generations.get(key) === generation;
}

/** Release the slot only if this execution still owns it. */
function endExecution(key: string, generation: number) {
  if (activeExecutions.get(key)?.generation === generation) activeExecutions.delete(key);
}

/** Which tab a run belongs to: its session, else the tab on screen. */
function tabKeyFor(session: string | undefined): string {
  return session ?? useResultStore.getState().viewTabId ?? NO_TAB;
}

type SliceWriter = (partial: Partial<TabResultSlice>) => void;

/**
 * Write a run's state where its tab keeps it: on screen when the tab is the
 * one shown (or none has been yet), parked otherwise.
 */
function tabWriter(key: string): SliceWriter {
  return (partial) => {
    const state = useResultStore.getState();
    if (state.viewTabId === null || state.viewTabId === key) {
      useResultStore.setState(partial);
      return;
    }
    useResultStore.setState({
      parked: { ...state.parked, [key]: { ...(state.parked[key] ?? EMPTY_SLICE), ...partial } },
    });
  };
}

/** True when any tab, shown or parked, has a statement running. */
export function anyTabExecuting(state: ResultState): boolean {
  return state.isExecuting || Object.values(state.parked).some((slice) => slice.isExecuting);
}

export const useResultStore = create<ResultState>((set, get) => ({
  results: [],
  activeResultIndex: 0,
  isExecuting: false,
  executionStartedAt: null,
  error: null,
  cancelledAfterMs: null,
  page: null,
  resultSource: null,

  explainResult: null,
  explainFormat: "classic",
  explainRequestedFormat: "classic",
  explainRequest: null,
  explainAnalyze: false,
  explainTabular: false,
  explainNotice: null,
  showExplain: false,

  confirmDialog: null,

  viewTabId: null,
  parked: {},

  showTab: (tabId) => {
    const state = get();
    if (state.viewTabId === tabId) return;
    if (state.viewTabId === null) {
      // Whatever ran before any tab was shown is the first tab's.
      set({ viewTabId: tabId });
      return;
    }
    const parked = { ...state.parked, [state.viewTabId]: pickSlice(state) };
    const next = (tabId !== null ? parked[tabId] : undefined) ?? EMPTY_SLICE;
    if (tabId !== null) delete parked[tabId];
    set({ ...next, parked, viewTabId: tabId });
  },

  forgetTabs: (liveTabIds) => {
    const live = new Set(liveTabIds);
    for (const key of [...generations.keys()]) {
      if (key !== NO_TAB && !live.has(key) && key !== get().viewTabId) {
        // A response still on its way for a closed tab has nowhere to go.
        generations.delete(key);
        activeExecutions.delete(key);
      }
    }
    const parked = get().parked;
    const kept = Object.fromEntries(Object.entries(parked).filter(([id]) => live.has(id)));
    if (Object.keys(kept).length !== Object.keys(parked).length) set({ parked: kept });
  },

  dropForeignResults: (connectionId) => {
    const { resultSource, isExecuting } = get();
    if (isExecuting || !resultSource || resultSource.connectionId === connectionId) return;
    set({
      results: [],
      activeResultIndex: 0,
      error: null,
      cancelledAfterMs: null,
      page: null,
      resultSource: null,
    });
  },

  executeQuery: async (connectionId, sql, database, session) => {
    // Production safety check
    if (isProductionConnection(connectionId) && isDestructiveStatement(sql)) {
      set({ confirmDialog: { isOpen: true, kind: "query", connectionId, sql, database, session } });
      return;
    }
    await doExecuteQuery(connectionId, sql, tabKeyFor(session), database, undefined, session);
  },

  confirmExecution: async () => {
    const dialog = get().confirmDialog;
    if (!dialog) return;
    set({ confirmDialog: null });
    if (dialog.kind === "explain-analyze") {
      await doExplain(
        dialog.connectionId,
        dialog.sql,
        true,
        tabKeyFor(dialog.session),
        dialog.database,
        get().explainRequestedFormat,
        dialog.session,
      );
      return;
    }
    await doExecuteQuery(
      dialog.connectionId,
      dialog.sql,
      tabKeyFor(dialog.session),
      dialog.database,
      undefined,
      dialog.session,
    );
  },

  cancelExecution: () => {
    set({ confirmDialog: null });
  },

  cancelActiveQuery: async () => {
    // Ctrl+. reaches here whether or not anything is running. With nothing to
    // stop, going on would wipe the results on screen as "Cancelled".
    if (!get().isExecuting) return;
    // Bumping the generation only makes this client ignore the response. The
    // statement keeps running — and holding locks — until the server is told to
    // stop, which is what cancelQuery does (#420).
    // The shown tab's run; another tab's query keeps running (#842).
    const key = get().viewTabId ?? lastStartedKey;
    const myGeneration = bumpGeneration(key);
    const connectionId = activeExecutions.get(key)?.connectionId ?? null;
    activeExecutions.delete(key);
    const startedAt = get().executionStartedAt;
    // What was on screen came from the query before, and leaving it there
    // read as that query's row count and timing (#850).
    set({
      isExecuting: false,
      executionStartedAt: null,
      error: null,
      cancelledAfterMs: startedAt === null ? 0 : Math.max(0, Date.now() - startedAt),
      results: [],
      activeResultIndex: 0,
      page: null,
      resultSource: null,
    });
    if (!connectionId) return;
    try {
      await api.cancelQuery(connectionId);
    } catch (e) {
      // Only while this cancel is still what the user is looking at. Telling
      // the server to stop can outlast the query it was about, and reporting
      // its failure over a query that started since would replace that
      // query's state with a message about one already gone (#287).
      if (!isCurrent(key, myGeneration)) return;
      tabWriter(key)({
        cancelledAfterMs: null,
        error: `Query cancelled, but the server did not confirm: ${String(e)}`,
      });
    }
  },

  setActiveResult: (index) => set({ activeResultIndex: index }),

  goToPage: async (index) => {
    const page = get().page;
    if (!page || index < 0 || index === page.index) return;
    await doExecuteQuery(
      page.connectionId,
      page.sql,
      tabKeyFor(page.session),
      page.database,
      { index, size: page.size },
      page.session,
    );
  },
  setShowExplain: (show) => set({ showExplain: show }),

  setExplainFormat: async (format) => {
    const request = get().explainRequest;
    if (!request) {
      set({ explainRequestedFormat: format });
      return;
    }
    await doExplain(
      request.connectionId,
      request.sql,
      request.analyze,
      tabKeyFor(request.session),
      request.database,
      format,
      request.session,
    );
  },
  clearResults: () =>
    set({
      results: [],
      activeResultIndex: 0,
      error: null,
      cancelledAfterMs: null,
      page: null,
      resultSource: null,
      explainResult: null,
      explainNotice: null,
      showExplain: false,
    }),
  clearError: () => set({ error: null }),

  executeExplain: async (connectionId, sql, database, format, session) => {
    await doExplain(connectionId, sql, false, tabKeyFor(session), database, format, session);
  },

  executeExplainAnalyze: async (connectionId, sql, database, format, session) => {
    // ANALYZE really runs the statement. The backend downgrades writes on its
    // own; production gets a prompt even for a read, because the cost is real.
    if (isProductionConnection(connectionId)) {
      set({
        confirmDialog: { isOpen: true, kind: "explain-analyze", connectionId, sql, database, session },
      });
      return;
    }
    await doExplain(connectionId, sql, true, tabKeyFor(session), database, format, session);
  },
}));

async function doExplain(
  connectionId: string,
  sql: string,
  analyze: boolean,
  /** The tab the plan belongs to (#842). */
  key: string,
  database?: string,
  format: ExplainFormat = "classic",
  session?: string,
) {
  const set = tabWriter(key);
  // The explain command is MySQL-only. Saying so beats letting the backend
  // answer "connection not found", which describes an internal detail rather
  // than the situation.
  if (connectionKind(connectionId) !== "mysql") {
    set({ error: "Query plans are not available for SQLite connections yet." });
    return;
  }

  const myGeneration = startExecution(key, connectionId);

  try {
    set({
      isExecuting: true,
      executionStartedAt: Date.now(),
      error: null,
      cancelledAfterMs: null,
      explainNotice: null,
      explainRequestedFormat: format,
      explainRequest: { connectionId, sql, database, analyze, session },
    });

    // Statement normalization (trailing `;`, multi-statement) and the
    // ANALYZE-safety decision both happen backend-side (#412, #418).
    if (session) noteSession(session, connectionId);
    const response = await api.explainQuery(connectionId, sql, analyze, database, format, session);
    if (!isCurrent(key, myGeneration)) return;

    set({
      explainResult: response.result,
      explainAnalyze: response.analyzed,
      explainTabular: response.tabular,
      explainFormat: response.format,
      // A refusal is about safety and a fallback is about what the server can
      // do; both end up as one line above the plan, and a refusal is the more
      // important of the two when they coincide.
      explainNotice: response.refusal
        ? REFUSAL_COPY[response.refusal] ?? null
        : response.format_fallback
        ? FALLBACK_COPY[response.format_fallback] ?? null
        : null,
      showExplain: true,
      isExecuting: false,
    });
  } catch (e) {
    // A cancel kills the statement server-side, so the in-flight call rejects
    // with the server's interrupt error. Reporting it would overwrite the
    // "cancelled" message the user just asked for.
    if (!isCurrent(key, myGeneration)) return;
    set({ error: String(e), isExecuting: false });
  } finally {
    endExecution(key, myGeneration);
  }
}

async function doExecuteQuery(
  connectionId: string,
  sql: string,
  /** The tab the results belong to (#842). */
  key: string,
  database?: string,
  /** Set when this run is a page change rather than a fresh execution. */
  paging?: { index: number; size: number },
  /** The editor tab whose session this runs on (#731). */
  session?: string,
) {
  const set = tabWriter(key);
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

  const myGeneration = startExecution(key, connectionId);

  try {
    set({ isExecuting: true, executionStartedAt: Date.now(), error: null, cancelledAfterMs: null });
    // Through the data source, so the editor runs a statement the same way
    // whichever backend the connection belongs to (#461).
    // Noted before the call: the backend opens the session as the statement
    // starts, and a tab closed while it runs should still end it.
    const source = dataSourceFor(connectionId);
    if (session && source.kind === "mysql") noteSession(session, connectionId);
    const results = await source.execute(
      connectionId,
      sql,
      effectiveDatabase,
      rowLimit,
      offset,
      session,
    );
    if (!isCurrent(key, myGeneration)) return;

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
      // Only a MySQL tab has a session of its own to come back to.
      resultSource: {
        connectionId,
        database: effectiveDatabase,
        session: source.kind === "mysql" ? session : undefined,
      },
      page: rowLimit !== undefined && (filled || pageIndex > 0)
        ? {
          sql,
          connectionId,
          database: effectiveDatabase,
          session,
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
    if (!isCurrent(key, myGeneration)) return;
    set({ error: String(e), isExecuting: false, results: [], page: null, resultSource: null });

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
    endExecution(key, myGeneration);
  }
}
