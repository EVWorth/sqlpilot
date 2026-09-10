import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../../lib/bindings";

const historyAdd = vi.hoisted(() => vi.fn());
const historyList = vi.hoisted(() => vi.fn());
const historyRemove = vi.hoisted(() => vi.fn());
const historyClear = vi.hoisted(() => vi.fn());
const historyPrune = vi.hoisted(() => vi.fn());
const historyImport = vi.hoisted(() => vi.fn());
const historyCountMatching = vi.hoisted(() => vi.fn());
const historyFacets = vi.hoisted(() => vi.fn());
const historyExport = vi.hoisted(() => vi.fn());
const historyPruneOlderThan = vi.hoisted(() => vi.fn());

vi.mock("../../lib/tauri-api", () => ({
  api: {
    historyAdd,
    historyList,
    historyRemove,
    historyClear,
    historyPrune,
    historyImport,
    historyCountMatching,
    historyFacets,
    historyExport,
    historyPruneOlderThan,
  },
}));

import {
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_HISTORY_MAX_AGE_DAYS,
  hasActiveFilters,
  type NewHistoryEntry,
  NO_FILTERS,
  retentionCutoff,
  useHistoryStore,
} from "../historyStore";

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "entry-1",
    sql: "SELECT 1",
    connectionName: "Test Connection",
    database: "test",
    executedAt: "2026-01-01T00:00:00Z",
    executionTimeMs: 100,
    rowCount: 1,
    status: "success",
    error: null,
    errorCode: null,
    errorSqlState: null,
    redacted: false,
    truncated: false,
    ...overrides,
  };
}

/** What a caller hands to addEntry — the store decides the rest. */
function newEntry(overrides: Partial<NewHistoryEntry> = {}): NewHistoryEntry {
  const { redacted: _r, truncated: _t, ...rest } = entry();
  return { ...rest, ...overrides };
}

describe("historyStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // The backend echoes back what it stored, so by default it stores what it
    // was given.
    historyAdd.mockImplementation(async (e: HistoryEntry) => e);
    historyList.mockResolvedValue([]);
    historyRemove.mockResolvedValue(undefined);
    historyClear.mockResolvedValue(undefined);
    historyPrune.mockResolvedValue(0);
    historyImport.mockResolvedValue(0);
    historyCountMatching.mockResolvedValue(0);
    historyFacets.mockResolvedValue({ connectionNames: [], databases: [] });
    historyExport.mockResolvedValue("");
    historyPruneOlderThan.mockResolvedValue(0);
    useHistoryStore.setState({
      entries: [],
      limit: DEFAULT_HISTORY_LIMIT,
      filters: { ...NO_FILTERS },
      matchCount: 0,
      facets: { connectionNames: [], databases: [] },
      loading: true,
      error: null,
      maxAgeDays: DEFAULT_HISTORY_MAX_AGE_DAYS,
    });
  });

  describe("load", () => {
    it("reads the entries the database holds", async () => {
      historyList.mockResolvedValue([entry({ id: "a" }), entry({ id: "b" })]);

      await useHistoryStore.getState().load();

      expect(useHistoryStore.getState().entries.map((e) => e.id)).toEqual(["a", "b"]);
      expect(useHistoryStore.getState().loading).toBe(false);
    });

    it("reports a failure instead of showing an empty history", async () => {
      historyList.mockRejectedValue(new Error("database is locked"));

      await useHistoryStore.getState().load();

      const state = useHistoryStore.getState();
      expect(state.loading).toBe(false);
      expect(state.error).toContain("database is locked");
    });
  });

  describe("addEntry", () => {
    it("writes through to the backend with the current limit", async () => {
      useHistoryStore.setState({ limit: 1000 });

      await useHistoryStore.getState().addEntry(newEntry({ sql: "SELECT 2" }));

      expect(historyAdd).toHaveBeenCalledWith(
        expect.objectContaining({ sql: "SELECT 2" }),
        1000,
      );
    });

    it("shows what the backend stored, not what was sent", async () => {
      // The backend cuts an over-long statement. Echoing the sent value would
      // show the user a row the database does not hold.
      historyAdd.mockResolvedValue(entry({ sql: "SELECT …cut", truncated: true }));

      await useHistoryStore.getState().addEntry(newEntry({ sql: "SELECT " + "x".repeat(100) }));

      const [stored] = useHistoryStore.getState().entries;
      expect(stored.sql).toBe("SELECT …cut");
      expect(stored.truncated).toBe(true);
    });

    it("puts the newest entry first", async () => {
      useHistoryStore.setState({ entries: [entry({ id: "old" })] });
      historyAdd.mockResolvedValue(entry({ id: "new" }));

      await useHistoryStore.getState().addEntry(newEntry());

      expect(useHistoryStore.getState().entries.map((e) => e.id)).toEqual(["new", "old"]);
    });

    it("does not throw when the history write fails", async () => {
      // Recording is a side effect of running a query. Failing to record must
      // not surface as the query having failed.
      historyAdd.mockRejectedValue(new Error("disk full"));

      await expect(useHistoryStore.getState().addEntry(newEntry())).resolves.toBeUndefined();
      expect(useHistoryStore.getState().error).toContain("disk full");
    });
  });

  describe("credential redaction (#587)", () => {
    it("never sends the password from a CREATE USER", async () => {
      await useHistoryStore.getState().addEntry(
        newEntry({ sql: "CREATE USER 'a'@'%' IDENTIFIED BY 's3cret'" }),
      );

      const [sent] = historyAdd.mock.calls[0];
      expect(sent.sql).not.toContain("s3cret");
      expect(sent.redacted).toBe(true);
    });

    it("redacts a password quoted back by the driver's error", async () => {
      await useHistoryStore.getState().addEntry(
        newEntry({
          status: "error",
          error: "near ALTER USER 'a'@'%' IDENTIFIED BY 'leaky': syntax error",
        }),
      );

      const [sent] = historyAdd.mock.calls[0];
      expect(sent.error).not.toContain("leaky");
      expect(sent.redacted).toBe(true);
    });

    it("leaves an ordinary statement unmarked", async () => {
      await useHistoryStore.getState().addEntry(
        newEntry({ sql: "SELECT * FROM users WHERE name = 'alice'" }),
      );

      const [sent] = historyAdd.mock.calls[0];
      expect(sent.sql).toBe("SELECT * FROM users WHERE name = 'alice'");
      expect(sent.redacted).toBe(false);
    });
  });

  describe("filters (#589)", () => {
    it("asks the database rather than filtering in memory", async () => {
      historyList.mockResolvedValue([entry({ id: "match" })]);

      await useHistoryStore.getState().setFilters({ search: "orders" });

      expect(historyList).toHaveBeenCalledWith(expect.objectContaining({ search: "orders" }));
      expect(useHistoryStore.getState().entries.map((e) => e.id)).toEqual(["match"]);
    });

    it("sends null rather than an empty search", async () => {
      await useHistoryStore.getState().setFilters({ search: "" });
      expect(historyList).toHaveBeenCalledWith(expect.objectContaining({ search: null }));
    });

    it("sends null for an empty filter list, not an empty array", async () => {
      // An empty list must mean "all"; sending [] would match nothing, so
      // unticking the last checkbox would empty the panel.
      await useHistoryStore.getState().setFilters({ connectionNames: [] });
      expect(historyList).toHaveBeenCalledWith(
        expect.objectContaining({ connectionNames: null, databases: null }),
      );
    });

    it("passes every filter through", async () => {
      await useHistoryStore.getState().setFilters({
        connectionNames: ["prod"],
        databases: ["app"],
        status: "error",
        executedAfter: "2026-01-01T00:00:00Z",
        executedBefore: "2026-01-02T23:59:59Z",
        minDurationMs: 250,
        sort: "slowest",
      });

      expect(historyList).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionNames: ["prod"],
          databases: ["app"],
          status: "error",
          executedAfter: "2026-01-01T00:00:00Z",
          executedBefore: "2026-01-02T23:59:59Z",
          minDurationMs: 250,
          sort: "slowest",
        }),
      );
    });

    it("records how many match, not just how many fit on the page", async () => {
      historyList.mockResolvedValue([entry({ id: "a" })]);
      historyCountMatching.mockResolvedValue(812);

      await useHistoryStore.getState().setFilters({ status: "error" });

      expect(useHistoryStore.getState().matchCount).toBe(812);
    });

    it("resets every filter at once", async () => {
      useHistoryStore.setState({
        filters: { ...NO_FILTERS, status: "error", connectionNames: ["prod"] },
      });

      await useHistoryStore.getState().resetFilters();

      expect(useHistoryStore.getState().filters).toEqual(NO_FILTERS);
    });

    it("ignores a read the user has already filtered past", async () => {
      // Two reads in flight; the first resolves last. Without the generation
      // guard the list snaps back to the stale filter's results.
      let resolveFirst: (v: HistoryEntry[]) => void = () => {};
      historyList.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)));
      historyList.mockImplementationOnce(async () => [entry({ id: "second" })]);

      const first = useHistoryStore.getState().setFilters({ search: "ord" });
      await useHistoryStore.getState().setFilters({ search: "orders" });
      resolveFirst([entry({ id: "first" })]);
      await first;

      expect(useHistoryStore.getState().entries.map((e) => e.id)).toEqual(["second"]);
    });

    it("knows when nothing is narrowing the view", () => {
      expect(hasActiveFilters(NO_FILTERS)).toBe(false);
      // A search is not a "filter" for the reset button's purposes — it has
      // its own visible box to clear.
      expect(hasActiveFilters({ ...NO_FILTERS, search: "x" })).toBe(false);
      expect(hasActiveFilters({ ...NO_FILTERS, status: "error" })).toBe(true);
      expect(hasActiveFilters({ ...NO_FILTERS, minDurationMs: 1 })).toBe(true);
    });
  });

  describe("export (#589)", () => {
    it("exports everything matching, not just the page", async () => {
      useHistoryStore.setState({ filters: { ...NO_FILTERS, status: "error" }, limit: 100 });
      historyExport.mockResolvedValue("executed_at,...");

      const out = await useHistoryStore.getState().exportMatching("csv");

      expect(historyExport).toHaveBeenCalledWith(
        expect.objectContaining({ status: "error", limit: null }),
        "csv",
      );
      expect(out).toBe("executed_at,...");
    });
  });

  describe("removeEntry", () => {
    it("drops the row and tells the backend", async () => {
      useHistoryStore.setState({ entries: [entry({ id: "a" }), entry({ id: "b" })] });

      await useHistoryStore.getState().removeEntry("a");

      expect(historyRemove).toHaveBeenCalledWith("a");
      expect(useHistoryStore.getState().entries.map((e) => e.id)).toEqual(["b"]);
    });

    it("puts the row back when the delete fails", async () => {
      useHistoryStore.setState({ entries: [entry({ id: "a" })] });
      historyRemove.mockRejectedValue(new Error("locked"));

      await useHistoryStore.getState().removeEntry("a");

      expect(useHistoryStore.getState().entries.map((e) => e.id)).toEqual(["a"]);
      expect(useHistoryStore.getState().error).toContain("locked");
    });
  });

  describe("clearHistory", () => {
    it("empties the panel and the database", async () => {
      useHistoryStore.setState({ entries: [entry()] });

      await useHistoryStore.getState().clearHistory();

      expect(historyClear).toHaveBeenCalled();
      expect(useHistoryStore.getState().entries).toEqual([]);
    });

    it("restores the entries when the clear fails", async () => {
      useHistoryStore.setState({ entries: [entry({ id: "a" })] });
      historyClear.mockRejectedValue(new Error("locked"));

      await useHistoryStore.getState().clearHistory();

      expect(useHistoryStore.getState().entries.map((e) => e.id)).toEqual(["a"]);
    });
  });

  describe("retention limit (#323)", () => {
    it("defaults to 500", () => {
      expect(DEFAULT_HISTORY_LIMIT).toBe(500);
    });

    it("prunes straight away rather than waiting for the next query", async () => {
      await useHistoryStore.getState().setLimit(100);

      expect(historyPrune).toHaveBeenCalledWith(100);
      expect(historyList).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it("remembers the choice across a reload", async () => {
      await useHistoryStore.getState().setLimit(5000);

      vi.resetModules();
      const mod = await import("../historyStore");
      expect(mod.useHistoryStore.getState().limit).toBe(5000);
    });

    it("ignores a stored limit that is not one of the offered values", async () => {
      localStorage.setItem("sqlpilot-history-limit", "7");

      vi.resetModules();
      const mod = await import("../historyStore");
      expect(mod.useHistoryStore.getState().limit).toBe(DEFAULT_HISTORY_LIMIT);
    });
  });

  describe("handover from localStorage (#585)", () => {
    const legacy = JSON.stringify({
      state: { entries: [{ id: "old-1", sql: "SELECT 1", connectionName: "Old" }] },
    });

    it("imports what was there and then forgets the key", async () => {
      localStorage.setItem("mas-query-history", legacy);

      await useHistoryStore.getState().load();

      expect(historyImport).toHaveBeenCalledWith(
        [expect.objectContaining({ id: "old-1", sql: "SELECT 1" })],
        DEFAULT_HISTORY_LIMIT,
      );
      expect(localStorage.getItem("mas-query-history")).toBeNull();
    });

    it("fills in fields the old entries never had", async () => {
      localStorage.setItem("mas-query-history", legacy);

      await useHistoryStore.getState().load();

      const [[imported]] = historyImport.mock.calls;
      expect(imported[0]).toMatchObject({
        database: null,
        errorCode: null,
        redacted: false,
        truncated: false,
        status: "success",
      });
      expect(typeof imported[0].executedAt).toBe("string");
    });

    it("keeps the old data when the import fails", async () => {
      // Deleting someone's only copy of their history because we could not
      // read it is the one outcome worth designing against.
      localStorage.setItem("mas-query-history", legacy);
      historyImport.mockRejectedValue(new Error("locked"));

      await useHistoryStore.getState().load();

      expect(localStorage.getItem("mas-query-history")).toBe(legacy);
    });

    it("keeps the old data when it cannot be parsed", async () => {
      localStorage.setItem("mas-query-history", "{ not json");

      await useHistoryStore.getState().load();

      expect(localStorage.getItem("mas-query-history")).toBe("{ not json");
      expect(historyImport).not.toHaveBeenCalled();
    });

    it("clears an empty legacy history without calling import", async () => {
      localStorage.setItem("mas-query-history", JSON.stringify({ state: { entries: [] } }));

      await useHistoryStore.getState().load();

      expect(historyImport).not.toHaveBeenCalled();
      expect(localStorage.getItem("mas-query-history")).toBeNull();
    });

    it("does nothing when there is no legacy history", async () => {
      await useHistoryStore.getState().load();
      expect(historyImport).not.toHaveBeenCalled();
    });
  });

  describe("age-based retention (#592)", () => {
    it("keeps everything by default", () => {
      expect(DEFAULT_HISTORY_MAX_AGE_DAYS).toBe(0);
      expect(retentionCutoff(0)).toBeNull();
    });

    it("computes the cutoff from the period", () => {
      const now = new Date("2026-03-01T00:00:00.000Z");
      expect(retentionCutoff(30, now)).toBe("2026-01-30T00:00:00.000Z");
    });

    it("prunes by age when the panel loads", async () => {
      useHistoryStore.setState({ maxAgeDays: 30 });

      await useHistoryStore.getState().load();

      expect(historyPruneOlderThan).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-/));
    });

    it("does not prune on load when set to forever", async () => {
      await useHistoryStore.getState().load();
      expect(historyPruneOlderThan).not.toHaveBeenCalled();
    });

    it("applies a newly chosen period straight away", async () => {
      await useHistoryStore.getState().setMaxAgeDays(7);

      expect(historyPruneOlderThan).toHaveBeenCalled();
      expect(useHistoryStore.getState().maxAgeDays).toBe(7);
    });

    it("does nothing but remember when set back to forever", async () => {
      // Raising the period cannot bring deleted entries back, so there is
      // nothing to apply.
      useHistoryStore.setState({ maxAgeDays: 7 });

      await useHistoryStore.getState().setMaxAgeDays(0);

      expect(historyPruneOlderThan).not.toHaveBeenCalled();
      expect(useHistoryStore.getState().maxAgeDays).toBe(0);
    });

    it("still shows the history when the age prune fails", async () => {
      // Retention is housekeeping. Failing at it must not stop the panel.
      useHistoryStore.setState({ maxAgeDays: 30 });
      historyPruneOlderThan.mockRejectedValue(new Error("locked"));
      historyList.mockResolvedValue([entry({ id: "a" })]);

      await useHistoryStore.getState().load();

      expect(useHistoryStore.getState().entries.map((e) => e.id)).toEqual(["a"]);
    });

    it("remembers the period across a reload", async () => {
      await useHistoryStore.getState().setMaxAgeDays(90);

      vi.resetModules();
      const mod = await import("../historyStore");
      expect(mod.useHistoryStore.getState().maxAgeDays).toBe(90);
    });
  });
});
