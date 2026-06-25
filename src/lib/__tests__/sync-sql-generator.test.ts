import { describe, expect, it } from "vitest";
import type { ColumnInfo, IndexInfo } from "../../types";
import type { SchemaComparison, SchemaSnapshot, TableDiff } from "../schema-diff";
import { generateSyncSQL } from "../sync-sql-generator";

function makeColumn(overrides: Partial<ColumnInfo> & { name: string }): ColumnInfo {
  return {
    data_type: "varchar",
    column_type: "varchar(255)",
    nullable: true,
    is_primary_key: false,
    extra: "",
    comment: "",
    ...overrides,
  };
}

function makeIndex(overrides: Partial<IndexInfo> & { name: string }): IndexInfo {
  return {
    columns: [],
    is_unique: false,
    index_type: "BTREE",
    ...overrides,
  };
}

function emptyComparison(): SchemaComparison {
  return {
    tables: { onlyInSource: [], onlyInTarget: [], different: [], identical: [] },
    views: { onlyInSource: [], onlyInTarget: [], different: [], identical: [] },
    routines: { onlyInSource: [], onlyInTarget: [], different: [], identical: [] },
    triggers: { onlyInSource: [], onlyInTarget: [], different: [], identical: [] },
  };
}

function emptySnapshot(): SchemaSnapshot {
  return { tables: [], views: [], routines: [], triggers: [] };
}

describe("sync-sql-generator", () => {
  it("generates CREATE TABLE for source-only tables", () => {
    const comparison = emptyComparison();
    comparison.tables.onlyInSource = ["users"];

    const snapshot = emptySnapshot();
    snapshot.tables = [{
      name: "users",
      columns: [
        makeColumn({ name: "id", column_type: "int", is_primary_key: true, nullable: false, extra: "auto_increment" }),
        makeColumn({ name: "email", column_type: "varchar(255)", nullable: false }),
      ],
      indexes: [],
    }];

    const stmts = generateSyncSQL(comparison, snapshot);
    expect(stmts).toHaveLength(1);
    expect(stmts[0].type).toBe("create");
    expect(stmts[0].sql).toContain("CREATE TABLE `users`");
    expect(stmts[0].sql).toContain("`id`");
    expect(stmts[0].sql).toContain("PRIMARY KEY");
    expect(stmts[0].destructive).toBe(false);
  });

  it("generates DROP TABLE for target-only tables", () => {
    const comparison = emptyComparison();
    comparison.tables.onlyInTarget = ["old_table"];

    const stmts = generateSyncSQL(comparison, emptySnapshot());
    expect(stmts).toHaveLength(1);
    expect(stmts[0].type).toBe("drop");
    expect(stmts[0].sql).toContain("DROP TABLE `old_table`");
    expect(stmts[0].sql).toContain("WARNING: destructive");
    expect(stmts[0].destructive).toBe(true);
  });

  it("generates ALTER TABLE for different tables", () => {
    const comparison = emptyComparison();
    const diff: TableDiff = {
      name: "users",
      columns: {
        added: [makeColumn({ name: "phone", column_type: "varchar(20)" })],
        removed: [makeColumn({ name: "fax" })],
        modified: [{
          name: "email",
          sourceColumn: makeColumn({ name: "email", column_type: "varchar(500)" }),
          targetColumn: makeColumn({ name: "email", column_type: "varchar(255)" }),
          changes: ["type: varchar(255) → varchar(500)"],
        }],
      },
      indexes: { added: [], removed: [] },
    };
    comparison.tables.different = [diff];

    const snapshot = emptySnapshot();
    snapshot.tables = [{ name: "users", columns: [], indexes: [] }];

    const stmts = generateSyncSQL(comparison, snapshot);
    expect(stmts).toHaveLength(1);
    expect(stmts[0].type).toBe("alter");
    expect(stmts[0].sql).toContain("ADD COLUMN `phone`");
    expect(stmts[0].sql).toContain("MODIFY COLUMN `email`");
    expect(stmts[0].sql).toContain("DROP COLUMN `fax`");
    expect(stmts[0].destructive).toBe(true);
  });

  it("generates index changes in ALTER TABLE", () => {
    const comparison = emptyComparison();
    const diff: TableDiff = {
      name: "users",
      columns: { added: [], removed: [], modified: [] },
      indexes: {
        added: [makeIndex({ name: "idx_email", columns: ["email"], is_unique: true })],
        removed: [makeIndex({ name: "idx_old", columns: ["old_col"] })],
      },
    };
    comparison.tables.different = [diff];

    const stmts = generateSyncSQL(comparison, emptySnapshot());
    expect(stmts).toHaveLength(1);
    expect(stmts[0].sql).toContain("DROP INDEX `idx_old`");
    expect(stmts[0].sql).toContain("ADD UNIQUE INDEX `idx_email`");
  });

  it("generates VIEW statements", () => {
    const comparison = emptyComparison();
    comparison.views.onlyInSource = [{ name: "v_users", is_updatable: false }];
    comparison.views.onlyInTarget = [{ name: "v_old", is_updatable: false }];
    comparison.views.different = ["v_changed"];

    const snapshot = emptySnapshot();
    snapshot.views = [
      { info: { name: "v_users", is_updatable: false }, ddl: "CREATE VIEW v_users AS SELECT * FROM users" },
      { info: { name: "v_changed", is_updatable: false }, ddl: "CREATE VIEW v_changed AS SELECT id FROM users" },
    ];

    const stmts = generateSyncSQL(comparison, snapshot);
    const createView = stmts.find((s) => s.objectName === "v_users");
    const dropView = stmts.find((s) => s.objectName === "v_old");
    const alterView = stmts.find((s) => s.objectName === "v_changed");

    expect(createView?.type).toBe("create");
    expect(dropView?.type).toBe("drop");
    expect(dropView?.destructive).toBe(true);
    expect(alterView?.type).toBe("alter");
    expect(alterView?.sql).toContain("OR REPLACE");
  });

  it("generates routine statements", () => {
    const comparison = emptyComparison();
    comparison.routines.onlyInSource = [{ name: "get_user", routine_type: "FUNCTION", data_type: "varchar" }];

    const snapshot = emptySnapshot();
    snapshot.routines = [
      {
        info: { name: "get_user", routine_type: "FUNCTION", data_type: "varchar" },
        ddl: "CREATE FUNCTION get_user() RETURNS varchar(255) BEGIN RETURN 'x'; END",
      },
    ];

    const stmts = generateSyncSQL(comparison, snapshot);
    expect(stmts).toHaveLength(1);
    expect(stmts[0].type).toBe("create");
    expect(stmts[0].objectType).toBe("FUNCTION");
  });

  it("generates trigger statements", () => {
    const comparison = emptyComparison();
    comparison.triggers.onlyInTarget = [{ name: "trg_old", event: "DELETE", table: "users", timing: "AFTER" }];

    const stmts = generateSyncSQL(comparison, emptySnapshot());
    expect(stmts).toHaveLength(1);
    expect(stmts[0].type).toBe("drop");
    expect(stmts[0].sql).toContain("DROP TRIGGER");
  });

  it("returns empty array for identical schemas", () => {
    const stmts = generateSyncSQL(emptyComparison(), emptySnapshot());
    expect(stmts).toHaveLength(0);
  });
});
