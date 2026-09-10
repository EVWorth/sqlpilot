import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../../lib/bindings";

const historyAdd = vi.hoisted(() => vi.fn());
const historyList = vi.hoisted(() => vi.fn());
const historyRemove = vi.hoisted(() => vi.fn());
const historyClear = vi.hoisted(() => vi.fn());
const historyPrune = vi.hoisted(() => vi.fn());
const historyImport = vi.hoisted(() => vi.fn());

vi.mock("../../lib/tauri-api", () => ({
  api: { historyAdd, historyList, historyRemove, historyClear, historyPrune, historyImport },
}));

import { DEFAULT_HISTORY_LIMIT, type NewHistoryEntry, useHistoryStore } from "../historyStore";

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
    useHistoryStore.setState({
      entries: [],
      limit: DEFAULT_HISTORY_LIMIT,
      search: "",
      loading: true,
      error: null,
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

  describe("search", () => {
    it("asks the database rather than filtering in memory", async () => {
      historyList.mockResolvedValue([entry({ id: "match" })]);

      await useHistoryStore.getState().setSearch("orders");

      expect(historyList).toHaveBeenCalledWith(
        expect.objectContaining({ search: "orders" }),
      );
      expect(useHistoryStore.getState().entries.map((e) => e.id)).toEqual(["match"]);
    });

    it("sends null rather than an empty search", async () => {
      await useHistoryStore.getState().setSearch("");
      expect(historyList).toHaveBeenCalledWith(expect.objectContaining({ search: null }));
    });

    it("ignores a result the user has already typed past", async () => {
      // Two searches in flight; the first resolves last. Without the guard the
      // list snaps back to the stale query's matches.
      let resolveFirst: (v: HistoryEntry[]) => void = () => {};
      historyList.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)));
      historyList.mockImplementationOnce(async () => [entry({ id: "second" })]);

      const first = useHistoryStore.getState().setSearch("ord");
      await useHistoryStore.getState().setSearch("orders");
      resolveFirst([entry({ id: "first" })]);
      await first;

      expect(useHistoryStore.getState().entries.map((e) => e.id)).toEqual(["second"]);
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
});
