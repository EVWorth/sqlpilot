import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectionKind,
  dataSourceFor,
  forgetConnectionKind,
  registerConnectionKind,
  SQLITE_SCHEMA_NAME,
} from "../datasource";
import { api } from "../tauri-api";

vi.mock("../tauri-api", () => ({
  api: {
    getDatabases: vi.fn(),
    getTables: vi.fn(),
    getViews: vi.fn(),
    getRoutines: vi.fn(),
    getTriggers: vi.fn(),
    getColumns: vi.fn(),
    getIndexes: vi.fn(),
    getTableDdl: vi.fn(),
    executeQuery: vi.fn(),
    sqliteGetTables: vi.fn(),
    sqliteGetColumns: vi.fn(),
    sqliteGetIndexes: vi.fn(),
    sqliteGetTableDdl: vi.fn(),
    sqliteExecute: vi.fn(),
  },
}));

describe("dataSourceFor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forgetConnectionKind("c-sqlite");
  });

  it("treats an unregistered id as MySQL, as it was before", () => {
    // Every existing caller passes a MySQL connection id and registers
    // nothing, so the default has to keep them working.
    expect(connectionKind("anything")).toBe("mysql");
    expect(dataSourceFor("anything").kind).toBe("mysql");
  });

  it("routes a registered SQLite id to the SQLite source", () => {
    registerConnectionKind("c-sqlite", "sqlite");
    expect(dataSourceFor("c-sqlite").kind).toBe("sqlite");
  });

  it("forgets a closed connection", () => {
    registerConnectionKind("c-sqlite", "sqlite");
    forgetConnectionKind("c-sqlite");
    expect(connectionKind("c-sqlite")).toBe("mysql");
  });
});

describe("the MySQL source", () => {
  it("passes calls straight through", async () => {
    vi.mocked(api.getTables).mockResolvedValue([]);
    await dataSourceFor("c-mysql").listTables("c-mysql", "app");
    expect(api.getTables).toHaveBeenCalledWith("c-mysql", "app");
  });
});

describe("the SQLite source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerConnectionKind("c-sqlite", "sqlite");
  });

  it("reports one database, so the tree keeps its shape", async () => {
    // A file has no databases to switch between. Reporting a single one lets
    // connection → database → tables stay identical for both backends.
    const dbs = await dataSourceFor("c-sqlite").listDatabases("c-sqlite");
    expect(dbs).toHaveLength(1);
    expect(dbs[0].name).toBe(SQLITE_SCHEMA_NAME);
    expect(dataSourceFor("c-sqlite").hasDatabases).toBe(false);
  });

  it("maps tables into the shared shape", async () => {
    vi.mocked(api.sqliteGetTables).mockResolvedValue([
      { name: "users", table_type: "table", row_count: 3, sql: "CREATE TABLE users (id)" },
    ] as never);

    const tables = await dataSourceFor("c-sqlite").listTables("c-sqlite", "main");

    expect(tables[0]).toMatchObject({ name: "users", table_type: "table", row_count: 3 });
    // Fields MySQL has and SQLite does not are present and empty, rather than
    // missing, so consumers do not have to guess which backend answered.
    expect(tables[0].engine).toBeNull();
    expect(tables[0].comment).toBe("");
  });

  it("maps columns, filling in what SQLite does not report", async () => {
    vi.mocked(api.sqliteGetColumns).mockResolvedValue([
      { name: "id", data_type: "INTEGER", nullable: false, default_value: null, is_primary_key: true },
    ] as never);

    const [col] = await dataSourceFor("c-sqlite").getColumns("c-sqlite", "main", "users");

    expect(col).toMatchObject({ name: "id", data_type: "INTEGER", is_primary_key: true });
    expect(col.column_type).toBe("INTEGER");
  });

  it("ignores the database argument, which SQLite has no use for", async () => {
    vi.mocked(api.sqliteGetColumns).mockResolvedValue([] as never);
    await dataSourceFor("c-sqlite").getColumns("c-sqlite", "ignored", "users");
    expect(api.sqliteGetColumns).toHaveBeenCalledWith("c-sqlite", "users");
  });

  it("has no views, routines or triggers to list", async () => {
    const source = dataSourceFor("c-sqlite");
    expect(await source.listViews("c-sqlite", "main")).toEqual([]);
    expect(await source.listRoutines("c-sqlite", "main")).toEqual([]);
    expect(await source.listTriggers("c-sqlite", "main")).toEqual([]);
  });

  it("maps a result set into the shape the grid renders", async () => {
    vi.mocked(api.sqliteExecute).mockResolvedValue([{
      query_id: "q1",
      statement_index: 0,
      columns: [{ name: "id", data_type: "INTEGER", nullable: false, is_primary_key: true }],
      rows: [[1]],
      rows_affected: 0,
      execution_time_ms: 2,
      warnings: [],
      rows_truncated: false,
    }] as never);

    const [result] = await dataSourceFor("c-sqlite").execute("c-sqlite", "SELECT 1");

    expect(result.rows).toEqual([[1]]);
    expect(result.columns[0].name).toBe("id");
    expect(api.sqliteExecute).toHaveBeenCalledWith("c-sqlite", "SELECT 1");
  });
});
