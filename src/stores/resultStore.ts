import { create } from "zustand";
import type { ExplainFormat } from "../lib/bindings";
import { connectionKind, dataSourceFor } from "../lib/datasource";
import { noteSession } from "../lib/server-sessions";
import { isDestructiveStatement } from "../lib/sql-safety";
import { api, CommandError } from "../lib/tauri-api";
import type { EditorTab, QueryResult } from "../types";
import { useConnectionStore } from "./connectionStore";
import { useEditorStore } from "./editorStore";
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
  /**
   * The tab the run belongs to, fixed when it was asked for, so approving it
   * after switching tabs still files the results under that tab (#842).
   */
  tabKey?: string;
  /**
   * The plan format asked for, for `explain-analyze`. Kept here rather than
   * read back from the store on approval, where it is the shown tab's.
   */
  format?: ExplainFormat;
}

/**
 * How a call to `executeQuery` ended, for a caller that has to act on it.
 *
 * Read from here rather than from the store's `error` afterwards: that is the
 * shown tab's, and after a tab switch mid-run it belongs to another run (#842).
 */
export type RunOutcome =
  | { status: "succeeded"; results: QueryResult[] }
  | { status: "failed"; error: string }
  /** Waiting on the production confirmation; nothing has run yet. */
  | { status: "awaiting-confirmation" }
  | { status: "cancelled" };

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
  /**
   * The tab a run that names no session lands in: the last query tab shown.
   * The schema tree, the designer and the routine viewer run statements
   * without a tab of their own, and their results belong in the results pane
   * the user last looked at, not in a designer tab that has none (#842).
   */
  runTabId: string | null;
  /** Every tab but the shown one's results, by tab id. */
  parked: Record<string, TabResultSlice>;
  /**
   * Show this tab's results, parking the ones on screen. `isQueryTab` false
   * marks a tab without a results pane, which session-less runs skip.
   */
  showTab: (tabId: string | null, isQueryTab?: boolean) => void;
  /** Drop the results of tabs that have closed. */
  forgetTabs: (liveTabIds: readonly string[]) => void;
  /**
   * Clear what is on screen if it was read on another connection, so a grid
   * from one server is not shown, or offered for editing, under another.
   */
  dropForeignResults: (connectionId: string | null | undefined) => void;

  /**
   * `session` is the editor tab running the statement, which keeps it on that
   * tab's own server session (#731). Only the editor passes one; a caller
   * that is not an editor tab leaves it out and runs on the shared pool.
   *
   * `tabId` files a run with no session under that tab rather than the last
   * query tab shown, for a caller that knew the tab before awaiting something
   * the user could switch tabs during (#842). Ignored when `session` is set.
   */
  executeQuery: (
    connectionId: string,
    sql: string,
    database?: string,
    session?: string,
    tabId?: string,
  ) => Promise<RunOutcome>;
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
 * Per run key, which run is the current one. A response whose generation is
 * not current any more is not shown: it was cancelled, the same tab started
 * another run since, or the tab has closed. Kept per tab so a run in one tab
 * does not discard the response another tab is waiting for (#842).
 *
 * A tab's own runs — the ones on its session — share the tab's key. A run
 * with no session gets a key of its own (see `sideKey`), so it never bumps the
 * generation of the tab it is filed under and so never discards, or takes the
 * cancel slot of, that tab's own run still in flight.
 */
const generations = new Map<string, number>();

/** Separates a tab id from the run counter in a session-less run's key. */
const SIDE_SEPARATOR = "\u0000";

let sideRuns = 0;

/** A fresh key for one session-less run filed under `tab`. */
function sideKey(tab: string): string {
  sideRuns += 1;
  return `${tab}${SIDE_SEPARATOR}${sideRuns}`;
}

/** The tab a run key belongs to. */
function tabOfKey(key: string): string {
  const at = key.indexOf(SIDE_SEPARATOR);
  return at < 0 ? key : key.slice(0, at);
}

/** Where a run is filed, and whether it is the tab's own. */
interface RunTarget {
  /** The tab whose results the run is filed under. */
  tab: string;
  /**
   * True for a run on the tab's own session, or on the grid it shows (paging,
   * a plan in another format). False for a run that names no session and only
   * borrows the tab's results pane: the schema tree, the designer, a refresh.
   */
  own: boolean;
}

/** One run, from start to response. */
interface Execution extends RunTarget {
  /** What its generation is counted under: the tab, or a key of its own. */
  key: string;
  generation: number;
  /**
   * When it started, relative to every other run. A session-less run shows
   * its response only if nothing has started in its tab since.
   */
  seq: number;
  connectionId: string;
  /** The editor tab session it runs on; absent on the shared pool. */
  session?: string;
  /** Set when the user cancelled it, so its interrupt error is not a failure. */
  cancelled: boolean;
  /** Set when its tab closed, so nothing is written for it any more. */
  orphaned: boolean;
}

/**
 * Every execution in flight, by run key, which is what cancel acts on and how
 * it knows which connection to tell the server about. Module-level rather
 * than store state because it is bookkeeping, not something a component
 * renders.
 *
 * A slower execution finishing must not clear the entry a newer one has
 * already installed, or cancel would find nothing and silently leave the
 * query running.
 */
const activeExecutions = new Map<string, Execution>();

/** Per tab, the `seq` of the last run started in it. */
const latestStart = new Map<string, number>();

let runCount = 0;

/** The tab the last run started in; what cancel acts on before any tab is shown. */
let lastStartedTab = NO_TAB;

function bumpGeneration(key: string): number {
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  return generation;
}

function startExecution(target: RunTarget, connectionId: string, session?: string): Execution {
  const key = target.own ? target.tab : sideKey(target.tab);
  runCount += 1;
  const run: Execution = {
    ...target,
    key,
    generation: bumpGeneration(key),
    seq: runCount,
    connectionId,
    session,
    cancelled: false,
    orphaned: false,
  };
  activeExecutions.set(key, run);
  latestStart.set(target.tab, run.seq);
  lastStartedTab = target.tab;
  return run;
}

/**
 * True while this run's response is still the one its tab is waiting for.
 *
 * A tab's own run stays current until the tab runs something else of its own
 * or cancels it. A session-less run is current only while nothing at all has
 * started in the tab since: it may not replace a newer run's results, but no
 * run replaces the tab's own one still in flight either.
 */
function isCurrent(run: Execution): boolean {
  if (run.orphaned || generations.get(run.key) !== run.generation) return false;
  return run.own || latestStart.get(run.tab) === run.seq;
}

/** True when a run other than `except` is still in flight in this tab. */
function tabBusy(tab: string, except?: Execution): boolean {
  for (const run of activeExecutions.values()) {
    if (run !== except && run.tab === tab && !run.cancelled) return true;
  }
  return false;
}

/** What cancel acts on in a tab: its own run, else its latest session-less one. */
function cancellableIn(tab: string): Execution | undefined {
  const own = activeExecutions.get(tab);
  if (own) return own;
  let latest: Execution | undefined;
  for (const run of activeExecutions.values()) {
    if (run.tab === tab && !run.cancelled && (!latest || run.seq > latest.seq)) latest = run;
  }
  return latest;
}

/**
 * Release the slot only if this execution still owns it, and stop the tab's
 * spinner if this was the last run in it and its response was not shown.
 */
function endExecution(run: Execution, shown: boolean) {
  if (activeExecutions.get(run.key) === run) activeExecutions.delete(run.key);
  if (!run.own) generations.delete(run.key);
  if (!shown && !run.orphaned && !tabBusy(run.tab)) {
    tabWriter(run.tab)({ isExecuting: false, executionStartedAt: null });
  }
}

/**
 * Which tab a run belongs to, decided when it starts: its session when it has
 * one, else the last query tab shown (#842).
 */
function tabKeyFor(session: string | undefined): string {
  if (session) return session;
  // Not the shown tab when it is not a query tab: a designer tab has no
  // results pane, so what is filed there is never seen. Filed under no tab,
  // it is adopted by the next query tab shown.
  return useResultStore.getState().runTabId ?? NO_TAB;
}

/**
 * Hand what was run under no tab to `tab`: the runs still in flight, so their
 * responses and the spinner land there, and cancel finds them there.
 */
function adoptUntabbed(tab: string) {
  for (const run of [...activeExecutions.values()]) {
    if (run.tab !== NO_TAB || run.orphaned) continue;
    run.tab = tab;
    if (run.own) {
      activeExecutions.delete(run.key);
      run.key = tab;
      run.generation = bumpGeneration(tab);
      activeExecutions.set(tab, run);
    }
  }
  generations.delete(NO_TAB);
  const started = latestStart.get(NO_TAB);
  if (started !== undefined) {
    latestStart.set(tab, Math.max(started, latestStart.get(tab) ?? 0));
    latestStart.delete(NO_TAB);
  }
  if (lastStartedTab === NO_TAB) lastStartedTab = tab;
}

/** Where a run that names `session`, or none, is filed. */
function targetFor(session: string | undefined, tab?: string): RunTarget {
  if (session) return { tab: session, own: true };
  return { tab: tab ?? tabKeyFor(undefined), own: false };
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

/**
 * True when any tab, shown or parked, has a statement running — including a
 * tab that has closed while its statement was still on the server.
 */
export function anyTabExecuting(state: ResultState): boolean {
  return state.isExecuting
    || Object.values(state.parked).some((slice) => slice.isExecuting)
    || [...activeExecutions.values()].some((run) => !run.cancelled);
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
  runTabId: null,
  parked: {},

  showTab: (tabId, isQueryTab = true) => {
    const state = get();
    const runTabId = isQueryTab && tabId !== null ? tabId : state.runTabId;
    if (state.viewTabId === tabId) {
      if (runTabId !== state.runTabId) set({ runTabId });
      return;
    }
    if (state.viewTabId === null) {
      // Whatever ran before any tab was shown is the first tab's, and so is
      // what is still running: its response would otherwise be parked under
      // no tab, and the spinner adopted here would never stop.
      if (tabId !== null) adoptUntabbed(tabId);
      set({ viewTabId: tabId, runTabId });
      return;
    }
    const parked = { ...state.parked, [state.viewTabId]: pickSlice(state) };
    let next = (tabId !== null ? parked[tabId] : undefined) ?? EMPTY_SLICE;
    if (tabId !== null && isQueryTab && !(tabId in parked) && parked[NO_TAB]) {
      // Run while no query tab was open, and kept for the next one.
      next = parked[NO_TAB];
      delete parked[NO_TAB];
      adoptUntabbed(tabId);
    }
    if (tabId !== null) delete parked[tabId];
    set({ ...next, parked, viewTabId: tabId, runTabId });
  },

  forgetTabs: (liveTabIds) => {
    const live = new Set(liveTabIds);
    const closed = (tab: string) => tab !== NO_TAB && !live.has(tab) && tab !== get().viewTabId;
    // A response still on its way for a closed tab has nowhere to be shown.
    // It is still recorded in history (see doExecuteQuery). The execution
    // itself stays listed until it settles: the statement is still running on
    // the server, which is what anyTabExecuting is asked about.
    for (const run of activeExecutions.values()) {
      if (closed(run.tab)) run.orphaned = true;
    }
    for (const key of [...generations.keys()]) {
      if (closed(tabOfKey(key))) generations.delete(key);
    }
    for (const tab of [...latestStart.keys()]) {
      if (closed(tab)) latestStart.delete(tab);
    }
    const { parked, runTabId } = get();
    // What ran under no tab waits for the next query tab to be shown.
    const kept = Object.fromEntries(Object.entries(parked).filter(([id]) => id === NO_TAB || live.has(id)));
    if (Object.keys(kept).length !== Object.keys(parked).length) set({ parked: kept });
    if (runTabId !== null && !live.has(runTabId)) set({ runTabId: null });
  },

  dropForeignResults: (connectionId) => {
    // Only the shown tab: a parked tab is checked against its own connection
    // when it is shown again.
    const { resultSource, explainRequest, isExecuting } = get();
    if (isExecuting) return;
    const current = connectionId ?? null;
    if (resultSource && resultSource.connectionId !== current) {
      set({
        results: [],
        activeResultIndex: 0,
        error: null,
        cancelledAfterMs: null,
        page: null,
        resultSource: null,
      });
    }
    if (explainRequest && explainRequest.connectionId !== current) {
      set({
        explainResult: null,
        explainRequest: null,
        explainNotice: null,
        explainAnalyze: false,
        explainTabular: false,
        showExplain: false,
      });
    }
  },

  executeQuery: async (connectionId, sql, database, session, tabId) => {
    const target = targetFor(session, tabId);
    // Production safety check
    if (isProductionConnection(connectionId) && isDestructiveStatement(sql)) {
      set({
        confirmDialog: { isOpen: true, kind: "query", connectionId, sql, database, session, tabKey: target.tab },
      });
      return { status: "awaiting-confirmation" };
    }
    return doExecuteQuery(connectionId, sql, target, database, undefined, session);
  },

  confirmExecution: async () => {
    const dialog = get().confirmDialog;
    if (!dialog) return;
    set({ confirmDialog: null });
    // Asked with no tab to file it under: the tab shown now, if it is one.
    const target = targetFor(dialog.session, dialog.tabKey || undefined);
    if (dialog.kind === "explain-analyze") {
      await doExplain(
        dialog.connectionId,
        dialog.sql,
        true,
        target,
        dialog.database,
        dialog.format,
        dialog.session,
      );
      return;
    }
    await doExecuteQuery(
      dialog.connectionId,
      dialog.sql,
      target,
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
    // The shown tab's run; another tab's query keeps running (#842). Its own
    // run when it has one in flight, not a session-less one filed under it.
    const tab = get().viewTabId ?? lastStartedTab;
    const running = cancellableIn(tab);
    if (running) {
      running.cancelled = true;
      bumpGeneration(running.key);
      activeExecutions.delete(running.key);
    }
    const connectionId = running?.connectionId ?? null;
    const cancelledAt = latestStart.get(tab);
    const startedAt = get().executionStartedAt;
    // What was on screen came from the query before, and leaving it there
    // read as that query's row count and timing (#850).
    set({
      // Still spinning if something else runs in the tab; Ctrl+. again stops it.
      isExecuting: tabBusy(tab),
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
      // Session: `running.session` — the tab session the run is on, absent
      // for a run on the shared pool.
      await api.cancelQuery(connectionId);
    } catch (e) {
      // Only while this cancel is still what the user is looking at. Telling
      // the server to stop can outlast the query it was about, and reporting
      // its failure over a query that started since would replace that
      // query's state with a message about one already gone (#287).
      if (latestStart.get(tab) !== cancelledAt) return;
      tabWriter(tab)({
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
      // The grid paging is the shown tab's.
      { tab: get().viewTabId ?? tabKeyFor(page.session), own: true },
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
      { tab: get().viewTabId ?? tabKeyFor(request.session), own: true },
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
    await doExplain(connectionId, sql, false, targetFor(session), database, format, session);
  },

  executeExplainAnalyze: async (connectionId, sql, database, format, session) => {
    // ANALYZE really runs the statement. The backend downgrades writes on its
    // own; production gets a prompt even for a read, because the cost is real.
    if (isProductionConnection(connectionId)) {
      set({
        confirmDialog: {
          isOpen: true,
          kind: "explain-analyze",
          connectionId,
          sql,
          database,
          session,
          tabKey: targetFor(session).tab,
          format,
        },
      });
      return;
    }
    await doExplain(connectionId, sql, true, targetFor(session), database, format, session);
  },
}));

async function doExplain(
  connectionId: string,
  sql: string,
  analyze: boolean,
  /** The tab the plan belongs to (#842). */
  target: RunTarget,
  database?: string,
  format: ExplainFormat = "classic",
  session?: string,
) {
  // The explain command is MySQL-only. Saying so beats letting the backend
  // answer "connection not found", which describes an internal detail rather
  // than the situation.
  if (connectionKind(connectionId) !== "mysql") {
    tabWriter(target.tab)({ error: "Query plans are not available for SQLite connections yet." });
    return;
  }

  const run = startExecution(target, connectionId, session);
  // Looked up at each write: a run started under no tab moves to the tab
  // that adopts it (see adoptUntabbed).
  const set: SliceWriter = (partial) => tabWriter(run.tab)(partial);
  let shown = false;

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
    if (!isCurrent(run)) return;

    shown = true;
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
      isExecuting: tabBusy(run.tab, run),
    });
  } catch (e) {
    // A cancel kills the statement server-side, so the in-flight call rejects
    // with the server's interrupt error. Reporting it would overwrite the
    // "cancelled" message the user just asked for.
    if (!isCurrent(run)) return;
    shown = true;
    set({ error: String(e), isExecuting: tabBusy(run.tab, run) });
  } finally {
    endExecution(run, shown);
  }
}

async function doExecuteQuery(
  connectionId: string,
  sql: string,
  /** The tab the results belong to (#842). */
  target: RunTarget,
  database?: string,
  /** Set when this run is a page change rather than a fresh execution. */
  paging?: { index: number; size: number },
  /** The editor tab whose session this runs on (#731). */
  session?: string,
): Promise<RunOutcome> {
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

  const run = startExecution(target, connectionId, session);
  // Looked up at each write: a run started under no tab moves to the tab
  // that adopts it (see adoptUntabbed).
  const set: SliceWriter = (partial) => tabWriter(run.tab)(partial);
  let shown = false;

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

    // Recorded before deciding whether to show it. The statement ran — and
    // may have written — whether or not its tab is still waiting for it: the
    // tab may have closed, or run something else since (#842).
    // A page change re-runs the same statement, so recording it again would
    // fill history with one row per Next click for a query the user ran once.
    if (!paging) {
      recordSuccess(results, sql, connectionId, connectionName, effectiveDatabase, startTime, conn === undefined);
    }

    if (!isCurrent(run)) return run.cancelled ? { status: "cancelled" } : { status: "succeeded", results };

    // Paging is offered only where a page actually filled up. A result that
    // came back short is the whole answer, and page controls on it would
    // invite a second round trip to fetch nothing.
    const filled = rowLimit !== undefined
      && results.some((r) => r.rows.length >= rowLimit);
    const pageIndex = paging?.index ?? 0;
    shown = true;
    set({
      results,
      activeResultIndex: 0,
      isExecuting: tabBusy(run.tab, run),
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
    return { status: "succeeded", results };
  } catch (e) {
    // A cancel kills the statement server-side, so this rejects with the
    // server's interrupt error. Reporting it would replace the "cancelled"
    // message with a raw database error and log the user's own cancellation
    // to history as a failed query.
    if (run.cancelled) return { status: "cancelled" };

    // Recorded whether or not the tab is still waiting, as a success is.
    // Without a connection the statement never reached a server, so the
    // entry would record an attempt rather than a query — and fifty rows
    // saying "Unknown connection" are fifty rows a user cannot act on or
    // trace back to anything (#328).
    if (conn) {
      // The driver's code and SQLSTATE ride along where it supplied them, so
      // the history panel can say which failure this was (#324).
      const structured = e instanceof CommandError ? e : undefined;
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
    }

    if (isCurrent(run)) {
      shown = true;
      set({ error: String(e), isExecuting: tabBusy(run.tab, run), results: [], page: null, resultSource: null });
    }
    return { status: "failed", error: String(e) };
  } finally {
    endExecution(run, shown);
  }
}

/** One history entry per statement of a run that succeeded. */
function recordSuccess(
  results: QueryResult[],
  sql: string,
  connectionId: string,
  connectionName: string,
  database: string | undefined,
  startTime: number,
  unknownConnection: boolean,
) {
  if (unknownConnection) {
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
      database: database ?? null,
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
}

/**
 * Show the editor's active tab's results, and drop closed tabs' (#842).
 *
 * Done in the store, synchronously, rather than in an effect after render:
 * code that opens a tab and runs a statement in it in one go — Show DDL in
 * the schema tree, re-running from history — would otherwise file the run
 * under the tab that was shown before.
 */
function followEditor(editor: { tabs: readonly EditorTab[]; activeTabId: string | null }) {
  const store = useResultStore.getState();
  const active = editor.tabs.find((t) => t.id === editor.activeTabId);
  store.showTab(editor.activeTabId, active?.type === "query");
  store.forgetTabs(editor.tabs.map((t) => t.id));
  // The last query tab closed: session-less runs go to another one, if any.
  if (useResultStore.getState().runTabId === null) {
    const fallback = editor.tabs.find((t) => t.type === "query");
    if (fallback) useResultStore.setState({ runTabId: fallback.id });
  }
}

/** The part of Vite's HMR handle this module uses. */
interface HotHandle {
  dispose: (cb: () => void) => void;
}

/**
 * Follow the editor store from now on. Returns the unsubscribe, which is also
 * handed to `hot` so a hot reload of this module drops the old subscription
 * rather than stacking a second one beside the new module's.
 */
export function followEditorStore(hot: HotHandle | undefined = import.meta.hot): (() => void) | undefined {
  // A test that replaces the editor store with a bare mock has nothing to follow.
  if (typeof useEditorStore.subscribe !== "function" || typeof useEditorStore.getState !== "function") {
    return undefined;
  }
  let seen = useEditorStore.getState();
  followEditor(seen);
  const unsub = useEditorStore.subscribe((editor) => {
    if (editor.tabs === seen.tabs && editor.activeTabId === seen.activeTabId) return;
    seen = editor;
    followEditor(editor);
  });
  hot?.dispose(unsub);
  return unsub;
}

followEditorStore();
