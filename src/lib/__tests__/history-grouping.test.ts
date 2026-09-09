import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../bindings";
import { groupConsecutive } from "../history-grouping";

function e(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "1",
    sql: "SELECT 1",
    connectionName: "prod",
    database: "app",
    executedAt: "2026-01-01T00:00:00Z",
    executionTimeMs: 10,
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

describe("groupConsecutive", () => {
  it("leaves distinct statements alone", () => {
    const groups = groupConsecutive([e({ id: "a", sql: "SELECT 1" }), e({ id: "b", sql: "SELECT 2" })]);
    expect(groups.map((g) => g.runs.length)).toEqual([1, 1]);
  });

  it("collapses a run of the same statement", () => {
    const groups = groupConsecutive([e({ id: "a" }), e({ id: "b" }), e({ id: "c" })]);

    expect(groups).toHaveLength(1);
    expect(groups[0].runs.map((r) => r.id)).toEqual(["a", "b", "c"]);
    // Entries arrive newest first, so the head is the most recent run.
    expect(groups[0].entry.id).toBe("a");
  });

  it("keeps non-adjacent repeats separate", () => {
    // SELECT, UPDATE, SELECT is someone checking their work. Merging the two
    // selects would hide that.
    const groups = groupConsecutive([
      e({ id: "a", sql: "SELECT 1" }),
      e({ id: "b", sql: "UPDATE t SET x = 1" }),
      e({ id: "c", sql: "SELECT 1" }),
    ]);

    expect(groups.map((g) => g.entry.id)).toEqual(["a", "b", "c"]);
  });

  it("does not merge across connections", () => {
    const groups = groupConsecutive([
      e({ id: "a", connectionName: "prod" }),
      e({ id: "b", connectionName: "staging" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("does not merge across databases", () => {
    const groups = groupConsecutive([e({ id: "a", database: "app" }), e({ id: "b", database: "logs" })]);
    expect(groups).toHaveLength(2);
  });

  it("does not merge a failure into a success", () => {
    // The outcome is the most important thing on the row. "×2" with a green
    // tick when one of them failed would be a lie.
    const groups = groupConsecutive([
      e({ id: "a", status: "error", error: "boom" }),
      e({ id: "b", status: "success" }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it("handles an empty history", () => {
    expect(groupConsecutive([])).toEqual([]);
  });

  it("does not mutate the entries it was given", () => {
    const entries = [e({ id: "a" }), e({ id: "b" })];
    const copy = structuredClone(entries);
    groupConsecutive(entries);
    expect(entries).toEqual(copy);
  });
});
