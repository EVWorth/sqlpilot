import { describe, expect, it } from "vitest";
import type { ProcessInfo } from "../../../types";
import { filterProcesses, hasProcessFilters, NO_PROCESS_FILTERS, processFilterOptions } from "../processFilter";

function p(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    id: 1,
    user: "app",
    host: "10.0.0.1:5000",
    db: "shop",
    command: "Query",
    time: 3,
    state: "Sending data",
    info: "SELECT * FROM orders",
    ...overrides,
  } as ProcessInfo;
}

const rows = [
  p({ id: 1, user: "app", db: "shop", state: "Sending data" }),
  p({ id: 2, user: "app", db: "shop", state: "Sleep", info: null }),
  p({ id: 3, user: "reporting", db: "analytics", state: "Sending data", info: "SELECT 1" }),
  p({ id: 4, user: "root", db: null, state: null, info: null }),
];

const ids = (list: ProcessInfo[]) => list.map((r) => r.id);

describe("filterProcesses (#437)", () => {
  it("returns everything with no filters", () => {
    expect(filterProcesses(rows, NO_PROCESS_FILTERS)).toHaveLength(4);
  });

  it("filters by user", () => {
    expect(ids(filterProcesses(rows, { ...NO_PROCESS_FILTERS, user: "app" }))).toEqual([1, 2]);
  });

  it("filters by database", () => {
    expect(ids(filterProcesses(rows, { ...NO_PROCESS_FILTERS, database: "analytics" }))).toEqual([3]);
  });

  it("filters by state", () => {
    expect(ids(filterProcesses(rows, { ...NO_PROCESS_FILTERS, state: "Sleep" }))).toEqual([2]);
  });

  it("combines filters with AND", () => {
    // "Sleeping connections belonging to app" is the question the single
    // free-text box could not express.
    const found = filterProcesses(rows, { ...NO_PROCESS_FILTERS, user: "app", state: "Sleep" });
    expect(ids(found)).toEqual([2]);
  });

  it("matches a process with no database via the placeholder", () => {
    expect(ids(filterProcesses(rows, { ...NO_PROCESS_FILTERS, database: "—" }))).toEqual([4]);
  });

  it("matches exactly, not by prefix", () => {
    // A user called "app" must not select one called "application".
    const withLonger = [...rows, p({ id: 5, user: "application" })];
    expect(ids(filterProcesses(withLonger, { ...NO_PROCESS_FILTERS, user: "app" }))).toEqual([1, 2]);
  });

  it("still searches free text across every column", () => {
    expect(ids(filterProcesses(rows, { ...NO_PROCESS_FILTERS, search: "orders" }))).toEqual([1]);
    expect(ids(filterProcesses(rows, { ...NO_PROCESS_FILTERS, search: "10.0.0.1" }))).toHaveLength(4);
  });

  it("searches case-insensitively and ignores surrounding space", () => {
    expect(ids(filterProcesses(rows, { ...NO_PROCESS_FILTERS, search: "  ORDERS " }))).toEqual([1]);
  });

  it("applies free text on top of the dropdowns", () => {
    const found = filterProcesses(rows, { ...NO_PROCESS_FILTERS, user: "app", search: "orders" });
    expect(ids(found)).toEqual([1]);
  });
});

describe("processFilterOptions", () => {
  it("offers only values that are actually connected", () => {
    // Listing every account on the server would offer users with no threads.
    expect(processFilterOptions(rows).users).toEqual(["app", "reporting", "root"]);
  });

  it("does not repeat a value", () => {
    expect(processFilterOptions(rows).databases.filter((d) => d === "shop")).toHaveLength(1);
  });

  it("puts the empty placeholder last", () => {
    expect(processFilterOptions(rows).databases).toEqual(["analytics", "shop", "—"]);
    expect(processFilterOptions(rows).states).toEqual(["Sending data", "Sleep", "—"]);
  });

  it("handles an empty list", () => {
    expect(processFilterOptions([])).toEqual({ users: [], databases: [], states: [] });
  });
});

describe("hasProcessFilters", () => {
  it("is false when nothing is set", () => {
    expect(hasProcessFilters(NO_PROCESS_FILTERS)).toBe(false);
  });

  it("is false for whitespace-only search", () => {
    expect(hasProcessFilters({ ...NO_PROCESS_FILTERS, search: "   " })).toBe(false);
  });

  it("is true for any set filter", () => {
    expect(hasProcessFilters({ ...NO_PROCESS_FILTERS, user: "app" })).toBe(true);
    expect(hasProcessFilters({ ...NO_PROCESS_FILTERS, search: "x" })).toBe(true);
  });
});
