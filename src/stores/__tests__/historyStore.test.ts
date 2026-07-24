import { beforeEach, describe, expect, it } from "vitest";
import { type HistoryEntry, useHistoryStore } from "../historyStore";

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: overrides.id ?? "entry-1",
    sql: overrides.sql ?? "SELECT 1",
    connectionName: overrides.connectionName ?? "Test Connection",
    database: overrides.database ?? "test",
    executedAt: overrides.executedAt ?? "2024-01-01T00:00:00Z",
    executionTimeMs: overrides.executionTimeMs ?? 100,
    rowCount: overrides.rowCount ?? 1,
    status: overrides.status ?? "success",
  };
}

describe("historyStore", () => {
  beforeEach(() => {
    useHistoryStore.setState({ entries: [] });
  });

  describe("addEntry", () => {
    it("adds entry to the beginning of entries", () => {
      const store = useHistoryStore.getState();
      store.addEntry(makeEntry({ id: "first", sql: "SELECT 1" }));
      store.addEntry(makeEntry({ id: "second", sql: "SELECT 2" }));

      const entries = useHistoryStore.getState().entries;
      expect(entries).toHaveLength(2);
      expect(entries[0].id).toBe("second");
      expect(entries[0].sql).toBe("SELECT 2");
      expect(entries[1].id).toBe("first");
      expect(entries[1].sql).toBe("SELECT 1");
    });

    it("adds single entry correctly", () => {
      useHistoryStore.getState().addEntry(makeEntry({ id: "single-entry", sql: "SELECT * FROM users" }));

      const entries = useHistoryStore.getState().entries;
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe("single-entry");
      expect(entries[0].sql).toBe("SELECT * FROM users");
      expect(entries[0].connectionName).toBe("Test Connection");
    });

    it("enforces MAX_ENTRIES of 500", () => {
      const store = useHistoryStore.getState();
      for (let i = 0; i < 600; i++) {
        store.addEntry(makeEntry({ id: `entry-${i}`, sql: `SELECT ${i}` }));
      }

      const entries = useHistoryStore.getState().entries;
      expect(entries).toHaveLength(500);
      expect(entries[0].id).toBe("entry-599");
      expect(entries[entries.length - 1].id).toBe("entry-100");
    });

    it("preserves all entry fields", () => {
      const entry: HistoryEntry = {
        id: "full-entry",
        sql: "SELECT * FROM users WHERE active = true",
        connectionName: "Production DB",
        database: "app_db",
        executedAt: "2024-06-15T12:30:00Z",
        executionTimeMs: 250,
        rowCount: 42,
        status: "success",
      };

      useHistoryStore.getState().addEntry(entry);

      const stored = useHistoryStore.getState().entries[0];
      expect(stored).toEqual(entry);
    });
  });

  describe("removeEntry", () => {
    it("removes an entry by id", () => {
      const store = useHistoryStore.getState();
      store.addEntry(makeEntry({ id: "keep", sql: "SELECT 1" }));
      store.addEntry(makeEntry({ id: "remove", sql: "SELECT 2" }));

      store.removeEntry("remove");

      const entries = useHistoryStore.getState().entries;
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe("keep");
    });

    it("does nothing if entry id not found", () => {
      const store = useHistoryStore.getState();
      store.addEntry(makeEntry({ id: "entry-1" }));
      store.addEntry(makeEntry({ id: "entry-2" }));

      store.removeEntry("non-existent");

      const entries = useHistoryStore.getState().entries;
      expect(entries).toHaveLength(2);
    });

    it("results in empty array when removing the only entry", () => {
      const store = useHistoryStore.getState();
      store.addEntry(makeEntry({ id: "only" }));

      store.removeEntry("only");

      expect(useHistoryStore.getState().entries).toEqual([]);
    });
  });

  describe("clearHistory", () => {
    it("removes all entries", () => {
      const store = useHistoryStore.getState();
      store.addEntry(makeEntry({ id: "entry-1" }));
      store.addEntry(makeEntry({ id: "entry-2" }));
      store.addEntry(makeEntry({ id: "entry-3" }));

      store.clearHistory();

      expect(useHistoryStore.getState().entries).toEqual([]);
    });

    it("works on already empty history", () => {
      useHistoryStore.getState().clearHistory();
      expect(useHistoryStore.getState().entries).toEqual([]);
    });
  });

  describe("entry shape edge cases", () => {
    it("preserves a failure entry with status=error and error message", () => {
      const entry: HistoryEntry = {
        id: "fail-1",
        sql: "SELECT * FROM missing_table",
        connectionName: "Test",
        database: "test",
        executedAt: "2024-01-01T00:00:00Z",
        executionTimeMs: 5,
        rowCount: 0,
        status: "error",
        error: "ERROR 1146 (42S02): Table 'x.y' doesn't exist",
      };
      useHistoryStore.getState().addEntry(entry);

      const stored = useHistoryStore.getState().entries[0];
      expect(stored.status).toBe("error");
      expect(stored.error).toBe("ERROR 1146 (42S02): Table 'x.y' doesn't exist");
      expect(stored.rowCount).toBe(0);
    });

    it("accepts an entry without the optional database field", () => {
      const entry: HistoryEntry = {
        id: "no-db",
        sql: "SELECT 1",
        connectionName: "Test",
        executedAt: "2024-01-01T00:00:00Z",
        executionTimeMs: 5,
        rowCount: 1,
        status: "success",
      };
      useHistoryStore.getState().addEntry(entry);

      const stored = useHistoryStore.getState().entries[0];
      expect(stored.database).toBeUndefined();
    });

    it("preserves very long SQL strings exactly (no truncation)", () => {
      const longSql = "SELECT " + "a, ".repeat(2000) + "b FROM huge_table";
      useHistoryStore.getState().addEntry(makeEntry({ id: "long", sql: longSql }));

      const stored = useHistoryStore.getState().entries[0];
      expect(stored.sql).toBe(longSql);
      expect(stored.sql.length).toBe(longSql.length);
    });

    it("accepts an empty SQL string without crashing", () => {
      useHistoryStore.getState().addEntry(makeEntry({ id: "empty", sql: "" }));

      const stored = useHistoryStore.getState().entries[0];
      expect(stored.sql).toBe("");
    });
  });

  describe("removeEntry idempotency", () => {
    it("calling removeEntry twice on the same id is a no-op the second time", () => {
      const store = useHistoryStore.getState();
      store.addEntry(makeEntry({ id: "a" }));
      store.addEntry(makeEntry({ id: "b" }));

      store.removeEntry("a");
      expect(useHistoryStore.getState().entries.map((e) => e.id)).toEqual(["b"]);

      // Second remove should be safe (no throw, no state change).
      store.removeEntry("a");
      expect(useHistoryStore.getState().entries.map((e) => e.id)).toEqual(["b"]);
    });
  });

  describe("persistence", () => {
    it("writes entries to localStorage under the persistence key", () => {
      useHistoryStore.getState().addEntry(makeEntry({ id: "persist-1", sql: "SELECT 9" }));

      const raw = localStorage.getItem("mas-query-history");
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      // zustand/persist wraps state under `state`
      expect(parsed.state.entries).toHaveLength(1);
      expect(parsed.state.entries[0].id).toBe("persist-1");
    });

    it("entries survive a store reinit (simulated reload)", async () => {
      const store = useHistoryStore.getState();
      store.addEntry(makeEntry({ id: "reload-1", sql: "SELECT 1" }));
      store.addEntry(makeEntry({ id: "reload-2", sql: "SELECT 2" }));

      // Simulate app reload: reset modules and re-import the store.
      vi.resetModules();
      const mod = await import("../historyStore");
      const restored = mod.useHistoryStore.getState().entries;
      expect(restored.map((e) => e.id)).toEqual(["reload-2", "reload-1"]);
    });

    it("clearHistory also clears the persisted localStorage entry", () => {
      const store = useHistoryStore.getState();
      store.addEntry(makeEntry({ id: "x" }));
      expect(localStorage.getItem("mas-query-history")).not.toBeNull();

      store.clearHistory();

      const raw = localStorage.getItem("mas-query-history");
      const parsed = JSON.parse(raw!);
      expect(parsed.state.entries).toEqual([]);
    });
  });
});
