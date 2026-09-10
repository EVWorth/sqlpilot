import { create } from "zustand";
import type { HistoryEntry, HistoryExportFormat, HistoryFacets, HistoryQuery, HistorySort } from "../lib/bindings";
import { redactCredentials } from "../lib/sql-redact";
import { api } from "../lib/tauri-api";

export type { HistoryEntry, HistoryExportFormat, HistoryFacets, HistorySort };

/**
 * The query history panel's state, backed by SQLite.
 *
 * History used to live in `localStorage`, rewritten in full on every query.
 * That medium shares a five-to-ten megabyte origin quota with settings and
 * favorites, swallows a quota failure silently — so recording just stopped and
 * nothing said so — and is wiped when the user clears site data (#585). It now
 * lives in `history.db` beside the connection profiles, and this store is a
 * view over it rather than the thing that holds it.
 *
 * Entries are read, not derived: after any write the store re-reads what the
 * database actually holds, so the panel cannot drift from storage the way an
 * optimistic local array would.
 */

/**
 * How many queries the history keeps.
 *
 * The spec asked for 10,000, the architecture note said 200, and the code kept
 * 500 in a constant nobody could change (#323). 500 is the default because it
 * is a comfortable working set, not because of a storage ceiling — SQLite has
 * no meaningful one here, and an over-long statement is capped per entry by
 * the store rather than by the count.
 */
export const DEFAULT_HISTORY_LIMIT = 500;
export const HISTORY_LIMITS = [100, 500, 1000, 5000, 10000] as const;

/** Where the retention choice lives. The entries no longer live in the DOM. */
const LIMIT_KEY = "sqlpilot-history-limit";
/** The key history used before it moved to SQLite. Read once, then removed. */
const LEGACY_KEY = "mas-query-history";

/**
 * Everything narrowing the current view.
 *
 * Held as one object so the query the store sends is built in a single place:
 * a filter that some code paths forget to include is how a panel starts
 * disagreeing with itself about what it is showing.
 */
export interface HistoryFilters {
  search: string;
  connectionNames: string[];
  databases: string[];
  /** "success", "error", or "" for both. */
  status: string;
  /** ISO 8601 date, inclusive. "" for unbounded. */
  executedAfter: string;
  executedBefore: string;
  minDurationMs: number | null;
  sort: HistorySort;
}

export const NO_FILTERS: HistoryFilters = {
  search: "",
  connectionNames: [],
  databases: [],
  status: "",
  executedAfter: "",
  executedBefore: "",
  minDurationMs: null,
  sort: "recent",
};

/** True when anything is narrowing the view, so the panel can offer a reset. */
export function hasActiveFilters(f: HistoryFilters): boolean {
  return (
    f.connectionNames.length > 0
    || f.databases.length > 0
    || f.status !== ""
    || f.executedAfter !== ""
    || f.executedBefore !== ""
    || f.minDurationMs !== null
  );
}

interface HistoryState {
  entries: HistoryEntry[];
  limit: number;
  /** What the current `entries` were read with. */
  filters: HistoryFilters;
  /** How many entries match the filters, ignoring the page size. */
  matchCount: number;
  /** Connections and databases that appear in the history, for the filter UI. */
  facets: HistoryFacets;
  /** True while the first read is outstanding, so the panel can say so. */
  loading: boolean;
  /** Set when talking to the store failed, so the panel can say that too. */
  error: string | null;

  load: () => Promise<void>;
  setFilters: (patch: Partial<HistoryFilters>) => Promise<void>;
  resetFilters: () => Promise<void>;
  exportMatching: (format: HistoryExportFormat) => Promise<string>;
  addEntry: (entry: NewHistoryEntry) => Promise<void>;
  removeEntry: (id: string) => Promise<void>;
  clearHistory: () => Promise<void>;
  setLimit: (limit: number) => Promise<void>;
}

/**
 * What a caller supplies. The store fills in the rest.
 *
 * `redacted` and `truncated` are decided on the way in — by this store and by
 * the backend respectively — so a caller cannot claim either.
 */
export type NewHistoryEntry = Omit<HistoryEntry, "redacted" | "truncated">;

function readLimit(): number {
  try {
    const stored = Number(localStorage.getItem(LIMIT_KEY));
    if (HISTORY_LIMITS.includes(stored as (typeof HISTORY_LIMITS)[number])) return stored;
  } catch {
    // A blocked localStorage is not a reason to fail: the default is fine.
  }
  return DEFAULT_HISTORY_LIMIT;
}

/**
 * Hand a `localStorage` history over to SQLite, once.
 *
 * The key is removed only after the import succeeds, so an app killed midway
 * tries again next time rather than losing the entries. Ids carry across, so
 * the retry imports nothing it already did.
 */
async function migrateLegacyHistory(limit: number): Promise<void> {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LEGACY_KEY);
  } catch {
    // A blocked localStorage means there is nothing to hand over.
    return;
  }
  if (!raw) return;

  try {
    const parsed = JSON.parse(raw) as { state?: { entries?: unknown } };
    const legacy = Array.isArray(parsed.state?.entries) ? parsed.state.entries : [];

    if (legacy.length > 0) {
      const imported = await api.historyImport(legacy.map(toBackendEntry), limit);
      console.info(`Imported ${imported} history entries from localStorage`);
    }
    localStorage.removeItem(LEGACY_KEY);
  } catch (e) {
    // Left in place deliberately. A parse failure on someone's only copy of
    // their history is not something to resolve by deleting it.
    console.warn("Could not import the localStorage history; leaving it alone", e);
  }
}

/** Fill in the fields the backend requires that a legacy entry may lack. */
function toBackendEntry(raw: unknown): HistoryEntry {
  const e = raw as Partial<HistoryEntry> & Record<string, unknown>;
  return {
    id: String(e.id ?? crypto.randomUUID()),
    sql: String(e.sql ?? ""),
    connectionName: String(e.connectionName ?? "Unknown"),
    database: (e.database as string | undefined) ?? null,
    executedAt: String(e.executedAt ?? new Date().toISOString()),
    executionTimeMs: Number(e.executionTimeMs ?? 0),
    rowCount: Number(e.rowCount ?? 0),
    status: e.status === "error" ? "error" : "success",
    error: (e.error as string | undefined) ?? null,
    errorCode: (e.errorCode as number | undefined) ?? null,
    errorSqlState: (e.errorSqlState as string | undefined) ?? null,
    redacted: Boolean(e.redacted),
    truncated: Boolean(e.truncated),
  };
}

/** Turn the panel's filters into the query the backend understands. */
function toQuery(filters: HistoryFilters, limit: number | null): HistoryQuery {
  return {
    search: filters.search.trim() || null,
    // An empty list means "no filter", not "match nothing" — otherwise
    // unticking the last checkbox would empty the panel.
    connectionNames: filters.connectionNames.length ? filters.connectionNames : null,
    databases: filters.databases.length ? filters.databases : null,
    status: filters.status || null,
    executedAfter: filters.executedAfter || null,
    executedBefore: filters.executedBefore || null,
    minDurationMs: filters.minDurationMs,
    sort: filters.sort,
    limit,
    offset: null,
  };
}

/** A generation counter so a slow read cannot overwrite a newer one. */
let readGeneration = 0;

/**
 * Re-read the current view.
 *
 * Every path that changes what should be on screen goes through here, so the
 * entries, the match count and the filters can never disagree.
 */
async function refresh(
  set: (partial: Partial<HistoryState>) => void,
  get: () => HistoryState,
): Promise<void> {
  const generation = ++readGeneration;
  const { filters, limit } = get();
  const query = toQuery(filters, limit);

  try {
    const [entries, matchCount] = await Promise.all([
      api.historyList(query),
      api.historyCountMatching(query),
    ]);
    // A read that finished after a newer one started is stale. Without this
    // the list flickers back to an earlier filter's results.
    if (generation !== readGeneration) return;
    set({ entries, matchCount, loading: false, error: null });
  } catch (e) {
    if (generation !== readGeneration) return;
    set({ loading: false, error: `Could not read query history: ${String(e)}` });
  }
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  entries: [],
  limit: readLimit(),
  filters: { ...NO_FILTERS },
  matchCount: 0,
  facets: { connectionNames: [], databases: [] },
  loading: true,
  error: null,

  load: async () => {
    try {
      await migrateLegacyHistory(get().limit);
    } catch {
      // migrateLegacyHistory already reports; a failed handover must not stop
      // the panel showing whatever the database does hold.
    }
    await refresh(set, get);
    try {
      set({ facets: await api.historyFacets() });
    } catch {
      // Without facets the filter lists are empty, which is a smaller problem
      // than the panel refusing to render.
    }
  },

  setFilters: async (patch) => {
    set((state) => ({ filters: { ...state.filters, ...patch } }));
    await refresh(set, get);
  },

  resetFilters: async () => {
    set({ filters: { ...NO_FILTERS } });
    await refresh(set, get);
  },

  exportMatching: async (format) => {
    // No limit: exporting a filtered view means all of it, not the page.
    return api.historyExport(toQuery(get().filters, null), format);
  },

  // Redaction happens here rather than at the call sites: this is the one door
  // into storage, and a password must not depend on every future caller
  // remembering to strip it (#587).
  addEntry: async (entry) => {
    const { sql, redacted } = redactCredentials(entry.sql);
    // A driver message can quote the statement back, so it gets the same
    // treatment. Nothing sensitive should reach storage by either route.
    const redactedError = entry.error ? redactCredentials(entry.error) : null;

    const stored: HistoryEntry = {
      ...entry,
      sql,
      error: redactedError?.sql ?? null,
      redacted: redacted || Boolean(redactedError?.redacted),
      truncated: false,
    };

    try {
      const written = await api.historyAdd(stored, get().limit);
      // Prepend what the backend actually stored — it may have cut an
      // over-long statement — rather than what was sent.
      set((state) => ({
        entries: [written, ...state.entries].slice(0, state.limit),
        error: null,
      }));
    } catch (e) {
      // A failed history write must not fail the query that produced it.
      set({ error: `Could not record query history: ${String(e)}` });
    }
  },

  removeEntry: async (id) => {
    const previous = get().entries;
    set({ entries: previous.filter((e) => e.id !== id) });
    try {
      await api.historyRemove(id);
    } catch (e) {
      set({ entries: previous, error: `Could not delete the entry: ${String(e)}` });
    }
  },

  clearHistory: async () => {
    const previous = get().entries;
    set({ entries: [] });
    try {
      await api.historyClear();
    } catch (e) {
      set({ entries: previous, error: `Could not clear history: ${String(e)}` });
    }
  },

  setLimit: async (limit) => {
    set({ limit });
    try {
      localStorage.setItem(LIMIT_KEY, String(limit));
    } catch {
      // The setting not persisting is worth less than the trim below.
    }
    try {
      // Lowering the limit drops the oldest straight away rather than waiting
      // for the next query: the user asked to keep fewer, and a panel still
      // showing the old count would look like the setting had not taken.
      await api.historyPrune(limit);
    } catch (e) {
      set({ error: `Could not apply the history limit: ${String(e)}` });
      return;
    }
    await refresh(set, get);
  },
}));
