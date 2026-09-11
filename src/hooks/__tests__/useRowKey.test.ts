import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/tauri-api";
import type { ColumnInfo, ColumnMeta, IndexInfo } from "../../types";
import { useRowKey } from "../useRowKey";

vi.mock("../../lib/tauri-api", () => ({
  api: { getColumns: vi.fn(), getIndexes: vi.fn() },
}));

const getColumns = vi.mocked(api.getColumns);
const getIndexes = vi.mocked(api.getIndexes);

function column(name: string, over: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    data_type: "int",
    column_type: "int",
    nullable: false,
    default_value: null,
    is_primary_key: false,
    extra: "",
    comment: "",
    charset: null,
    collation: null,
    ...over,
  };
}

function index(name: string, columns: string[], is_unique = true): IndexInfo {
  return { name, columns, is_unique, index_type: "BTREE" };
}

/** What the grid shows, which is always is_primary_key: false (#387). */
function onScreen(...names: string[]): ColumnMeta[] {
  return names.map((name) => ({
    name,
    data_type: "int",
    nullable: true,
    is_primary_key: false,
  }));
}

const render = (sql: string, columns: ColumnMeta[]) => renderHook(() => useRowKey("conn", "shop", sql, columns));

describe("useRowKey (#387, #400)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIndexes.mockResolvedValue([]);
  });

  it("finds the primary key from the schema, not from the result metadata", async () => {
    getColumns.mockResolvedValue([column("id", { is_primary_key: true }), column("email")]);

    const { result } = render("SELECT * FROM users", onScreen("id", "email"));

    await waitFor(() => expect(result.current.addressable).toBe(true));
    expect(result.current.columns).toEqual(["id"]);
    expect(result.current.state).toMatchObject({ status: "ready", source: "primary-key" });
  });

  it("requires every part of a composite key to be on screen", async () => {
    getColumns.mockResolvedValue([
      column("order_id", { is_primary_key: true }),
      column("line_no", { is_primary_key: true }),
      column("qty"),
    ]);

    const { result } = render("SELECT order_id, qty FROM order_lines", onScreen("order_id", "qty"));

    await waitFor(() => expect(result.current.state.status).toBe("key-not-selected"));
    expect(result.current.addressable).toBe(false);
    expect(result.current.state).toMatchObject({ columns: ["order_id", "line_no"] });
  });

  it("falls back to a unique index over NOT NULL columns", async () => {
    getColumns.mockResolvedValue([column("sku"), column("name")]);
    getIndexes.mockResolvedValue([index("uq_sku", ["sku"])]);

    const { result } = render("SELECT * FROM products", onScreen("sku", "name"));

    await waitFor(() => expect(result.current.addressable).toBe(true));
    expect(result.current.columns).toEqual(["sku"]);
    expect(result.current.state).toMatchObject({ source: "unique-index" });
  });

  it("will not use a unique index over a nullable column", async () => {
    // UNIQUE does not constrain NULLs in MySQL, so two rows can share one.
    getColumns.mockResolvedValue([column("sku", { nullable: true }), column("name")]);
    getIndexes.mockResolvedValue([index("uq_sku", ["sku"])]);

    const { result } = render("SELECT * FROM products", onScreen("sku", "name"));

    await waitFor(() => expect(result.current.state.status).toBe("no-key"));
  });

  it("will not use a non-unique index", async () => {
    getColumns.mockResolvedValue([column("sku"), column("name")]);
    getIndexes.mockResolvedValue([index("idx_sku", ["sku"], false)]);

    const { result } = render("SELECT * FROM products", onScreen("sku", "name"));

    await waitFor(() => expect(result.current.state.status).toBe("no-key"));
  });

  it("prefers the narrowest usable unique index", async () => {
    getColumns.mockResolvedValue([column("a"), column("b"), column("c")]);
    getIndexes.mockResolvedValue([index("uq_ab", ["a", "b"]), index("uq_c", ["c"])]);

    const { result } = render("SELECT * FROM t", onScreen("a", "b", "c"));

    await waitFor(() => expect(result.current.columns).toEqual(["c"]));
  });

  it("matches on every column only when the table really has no key", async () => {
    getColumns.mockResolvedValue([column("name"), column("note")]);

    const { result } = render("SELECT * FROM notes", onScreen("name", "note"));

    await waitFor(() => expect(result.current.state.status).toBe("no-key"));
    expect(result.current.columns).toEqual(["name", "note"]);
    expect(result.current.addressable).toBe(false);
  });

  it("reports a join as not a table rather than reading a schema", async () => {
    const { result } = render(
      "SELECT * FROM users u JOIN orders o ON o.user_id = u.id",
      onScreen("id"),
    );

    await waitFor(() => expect(result.current.state.status).toBe("not-a-table"));
    expect(getColumns).not.toHaveBeenCalled();
  });

  it("stays unknown when the schema cannot be read", async () => {
    // Claiming no key would invite the all-columns WHERE this exists to avoid.
    getColumns.mockRejectedValue(new Error("access denied"));

    const { result } = render("SELECT * FROM users", onScreen("id"));

    await waitFor(() => expect(getColumns).toHaveBeenCalled());
    expect(result.current.state.status).toBe("unknown");
    expect(result.current.addressable).toBe(false);
  });

  it("ignores a schema read that resolves after the result changed", async () => {
    let release: (v: ColumnInfo[]) => void = () => {};
    getColumns.mockReturnValueOnce(new Promise<ColumnInfo[]>((r) => (release = r)));
    getColumns.mockResolvedValue([column("id", { is_primary_key: true })]);

    const { result, rerender } = renderHook(
      ({ sql }: { sql: string }) => useRowKey("conn", "shop", sql, onScreen("id")),
      { initialProps: { sql: "SELECT * FROM slow" } },
    );

    rerender({ sql: "SELECT * FROM users" });
    await waitFor(() => expect(result.current.state).toMatchObject({ table: "users" }));

    release([column("id", { is_primary_key: true })]);
    await Promise.resolve();
    expect(result.current.state).toMatchObject({ table: "users" });
  });
});
