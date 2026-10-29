import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnInfo, ConnectionInfo, IndexInfo, QueryError, TableInfo } from "../../../lib/bindings";
import { type DesignerColumn, generateAlterTable, type TableDesignerConfig } from "../../../lib/ddl-generator";
import { call, install, rejection, settle } from "./helpers";

let conn: ConnectionInfo;

const run = (sql: string) => settle(call("execute_query", { connectionId: conn.id, sql, database: "shop" }));
const refused = (sql: string) =>
  settle(rejection("execute_query", { connectionId: conn.id, sql, database: "shop" })) as Promise<QueryError>;
const columns = (table: string) =>
  settle(call<ColumnInfo[]>("get_columns", { connectionId: conn.id, database: "shop", table }));
const indexes = (table: string) =>
  settle(call<IndexInfo[]>("get_indexes", { connectionId: conn.id, database: "shop", table }));
const tables = () => settle(call<TableInfo[]>("get_tables", { connectionId: conn.id, database: "shop" }));
const ddl = (table: string) =>
  settle(call<string>("get_table_ddl", { connectionId: conn.id, database: "shop", table }));

const designerColumn = (c: ColumnInfo, i: number): DesignerColumn => ({
  id: `c${i}`,
  name: c.name,
  type: c.data_type.toUpperCase(),
  length: /\(([^)]*)\)/.exec(c.column_type)?.[1] ?? "",
  nullable: c.nullable,
  defaultValue: c.default_value ?? "",
  autoIncrement: c.extra.includes("auto_increment"),
  comment: c.comment,
  unsigned: c.column_type.includes("unsigned"),
});

describe("schema writes", () => {
  beforeEach(async () => {
    install("?mock=connected");
    vi.useFakeTimers();
    conn = await call<ConnectionInfo>("connect", { profileId: "profile-local" });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows the designer's ALTER in the reads after it", async () => {
    const before = await columns("customers");
    const original: TableDesignerConfig = {
      tableName: "customers",
      database: "shop",
      columns: before.map(designerColumn),
      indexes: [],
      foreignKeys: [],
      options: { engine: "InnoDB", charset: "", collation: "", autoIncrementStart: "", comment: "" },
    };
    const modified: TableDesignerConfig = {
      ...original,
      columns: [
        ...original.columns.filter((c) => c.name !== "city").map((c) =>
          c.name === "first_name" ? { ...c, name: "given_name", comment: "As they write it" } : c
        ),
        {
          id: "new",
          name: "loyalty_points",
          type: "INT",
          length: "",
          nullable: false,
          defaultValue: "0",
          autoIncrement: false,
          comment: "",
        },
      ],
      indexes: [{ id: "i1", name: "idx_customers_points", type: "INDEX", columns: ["loyalty_points"] }],
      options: { ...original.options, comment: "Everyone who has bought something" },
    };
    await run(generateAlterTable("customers", original, modified));

    const after = await columns("customers");
    expect(after.map((c) => c.name)).toEqual([
      "id",
      "given_name",
      "last_name",
      "email",
      "is_active",
      "created_at",
      "loyalty_points",
    ]);
    expect(after.find((c) => c.name === "given_name")).toMatchObject({ comment: "As they write it" });
    expect(after.find((c) => c.name === "loyalty_points")).toMatchObject({
      column_type: "int",
      nullable: false,
      default_value: "0",
    });
    expect((await indexes("customers")).map((i) => i.name)).toContain("idx_customers_points");
    expect((await tables()).find((t) => t.name === "customers")?.comment).toBe("Everyone who has bought something");
    expect(await ddl("customers")).toContain("KEY `idx_customers_points` (`loyalty_points`)");

    // The grid reads the new column too, at its default.
    const rows = await settle(
      call<{ rows: unknown[][] }[]>("execute_query", {
        connectionId: conn.id,
        sql: "SELECT loyalty_points FROM customers LIMIT 2",
        database: "shop",
      }),
    );
    expect(rows[0].rows).toEqual([[0], [0]]);
  });

  it("applies all of an ALTER or none of it", async () => {
    const error = await refused("ALTER TABLE orders ADD COLUMN shipped_at DATETIME NULL, ADD COLUMN status INT");
    expect(error).toMatchObject({ code: 1060, message: "Duplicate column name 'status'" });
    expect((await columns("orders")).map((c) => c.name)).not.toContain("shipped_at");
  });

  it("creates, renames and drops tables", async () => {
    await run(
      "CREATE TABLE refunds (\n  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  order_id INT UNSIGNED NOT NULL,\n"
        + "  amount DECIMAL(10, 2) NOT NULL,\n  CONSTRAINT fk_refunds_order FOREIGN KEY (order_id) REFERENCES orders (id)"
        + " ON DELETE CASCADE\n) ENGINE=InnoDB COMMENT='Money returned'",
    );
    expect((await tables()).find((t) => t.name === "refunds")).toMatchObject({
      comment: "Money returned",
      row_count: 0,
    });
    expect((await columns("refunds")).map((c) => [c.name, c.column_type, c.is_primary_key])).toEqual([
      ["id", "int unsigned", true],
      ["order_id", "int unsigned", false],
      ["amount", "decimal(10,2)", false],
    ]);
    const fks = await settle(call("get_foreign_keys", { connectionId: conn.id, database: "shop", table: "refunds" }));
    expect(fks).toEqual([expect.objectContaining({ name: "fk_refunds_order", on_delete: "CASCADE" })]);

    await run("RENAME TABLE refunds TO order_refunds");
    expect((await tables()).map((t) => t.name)).toContain("order_refunds");
    expect((await indexes("order_refunds")).map((i) => i.name)).toContain("PRIMARY");

    await run("DROP TABLE order_refunds");
    expect((await tables()).map((t) => t.name)).not.toContain("order_refunds");
    expect(await refused("DROP TABLE order_refunds")).toMatchObject({ code: 1051 });
  });

  it("rejects obviously invalid DDL", async () => {
    expect(await refused("CREATE TABLE orders ()")).toMatchObject({
      code: 1064,
      sqlState: "42000",
      message: expect.stringContaining("near ')' at line 1"),
    });
    expect(await refused("CREATE TABLE orders (id INT)")).toMatchObject({ code: 1050 });
    expect(await refused("CREATE TABLE t (id NOTATYPE)")).toMatchObject({ code: 1064 });
    expect(await refused("CREATE TABLE t (id INT,)")).toMatchObject({ code: 1064 });
    expect(await refused("ALTER TABLE nope ADD COLUMN x INT")).toMatchObject({ code: 1146 });
    expect(await refused("ALTER TABLE orders DROP COLUMN nope")).toMatchObject({ code: 1091 });
    expect(await refused("ALTER TABLE orders ADD INDEX idx_orders_customer (total)")).toMatchObject({ code: 1061 });
  });

  it("starts from the fixture again on a fresh install", async () => {
    await run("ALTER TABLE products DROP COLUMN description");
    expect((await columns("products")).map((c) => c.name)).not.toContain("description");
    install("?mock=connected");
    conn = await call<ConnectionInfo>("connect", { profileId: "profile-local" });
    expect((await columns("products")).map((c) => c.name)).toContain("description");
  });
});
