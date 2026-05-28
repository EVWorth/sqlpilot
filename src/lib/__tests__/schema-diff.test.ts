import { describe, it, expect } from "vitest";
import {
  compareColumns,
  compareIndexes,
  compareSchemas,
} from "../schema-diff";
import type { SchemaSnapshot } from "../schema-diff";
import type { ColumnInfo, IndexInfo } from "../../types";

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

describe("schema-diff", () => {
  describe("compareColumns", () => {
    it("detects added columns", () => {
      const source = [makeColumn({ name: "id" }), makeColumn({ name: "email" })];
      const target = [makeColumn({ name: "id" })];
      const result = compareColumns(source, target);
      expect(result.added).toHaveLength(1);
      expect(result.added[0].name).toBe("email");
      expect(result.removed).toHaveLength(0);
      expect(result.modified).toHaveLength(0);
    });

    it("detects removed columns", () => {
      const source = [makeColumn({ name: "id" })];
      const target = [makeColumn({ name: "id" }), makeColumn({ name: "email" })];
      const result = compareColumns(source, target);
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0].name).toBe("email");
    });

    it("detects type changes", () => {
      const source = [makeColumn({ name: "name", column_type: "varchar(200)" })];
      const target = [makeColumn({ name: "name", column_type: "varchar(100)" })];
      const result = compareColumns(source, target);
      expect(result.modified).toHaveLength(1);
      expect(result.modified[0].changes).toContain("type: varchar(100) → varchar(200)");
    });

    it("detects nullable changes", () => {
      const source = [makeColumn({ name: "name", nullable: false })];
      const target = [makeColumn({ name: "name", nullable: true })];
      const result = compareColumns(source, target);
      expect(result.modified).toHaveLength(1);
      expect(result.modified[0].changes).toContain("nullable: YES → NO");
    });

    it("detects default value changes", () => {
      const source = [makeColumn({ name: "status", default_value: "active" })];
      const target = [makeColumn({ name: "status", default_value: "pending" })];
      const result = compareColumns(source, target);
      expect(result.modified).toHaveLength(1);
      expect(result.modified[0].changes).toContain("default: pending → active");
    });

    it("detects extra column changes", () => {
      const source = [makeColumn({ name: "id", extra: "auto_increment" })];
      const target = [makeColumn({ name: "id", extra: "" })];
      const result = compareColumns(source, target);
      expect(result.modified).toHaveLength(1);
      expect(result.modified[0].changes).toContain("extra: (none) → auto_increment");
    });

    it("detects comment changes", () => {
      const source = [makeColumn({ name: "id", comment: "Primary key" })];
      const target = [makeColumn({ name: "id", comment: "" })];
      const result = compareColumns(source, target);
      expect(result.modified).toHaveLength(1);
      expect(result.modified[0].changes).toContain('comment: "" → "Primary key"');
    });

    it("reports identical columns as no changes", () => {
      const col = makeColumn({ name: "id" });
      const result = compareColumns([col], [col]);
      expect(result.added).toHaveLength(0);
      expect(result.removed).toHaveLength(0);
      expect(result.modified).toHaveLength(0);
    });
  });

  describe("compareIndexes", () => {
    it("detects added indexes", () => {
      const source = [makeIndex({ name: "idx_email", columns: ["email"] })];
      const target: IndexInfo[] = [];
      const result = compareIndexes(source, target);
      expect(result.added).toHaveLength(1);
      expect(result.added[0].name).toBe("idx_email");
    });

    it("detects removed indexes", () => {
      const source: IndexInfo[] = [];
      const target = [makeIndex({ name: "idx_email", columns: ["email"] })];
      const result = compareIndexes(source, target);
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0].name).toBe("idx_email");
    });

    it("detects changed indexes as remove+add", () => {
      const source = [makeIndex({ name: "idx_name", columns: ["first_name", "last_name"] })];
      const target = [makeIndex({ name: "idx_name", columns: ["first_name"] })];
      const result = compareIndexes(source, target);
      expect(result.added).toHaveLength(1);
      expect(result.removed).toHaveLength(1);
    });
  });

  describe("compareSchemas", () => {
    it("detects tables only in source", () => {
      const source: SchemaSnapshot = {
        tables: [{ name: "users", columns: [], indexes: [] }],
        views: [],
        routines: [],
        triggers: [],
      };
      const target: SchemaSnapshot = {
        tables: [],
        views: [],
        routines: [],
        triggers: [],
      };
      const result = compareSchemas(source, target);
      expect(result.tables.onlyInSource).toEqual(["users"]);
      expect(result.tables.onlyInTarget).toEqual([]);
    });

    it("detects tables only in target", () => {
      const source: SchemaSnapshot = {
        tables: [],
        views: [],
        routines: [],
        triggers: [],
      };
      const target: SchemaSnapshot = {
        tables: [{ name: "orders", columns: [], indexes: [] }],
        views: [],
        routines: [],
        triggers: [],
      };
      const result = compareSchemas(source, target);
      expect(result.tables.onlyInTarget).toEqual(["orders"]);
    });

    it("detects identical tables", () => {
      const col = makeColumn({ name: "id" });
      const source: SchemaSnapshot = {
        tables: [{ name: "users", columns: [col], indexes: [] }],
        views: [],
        routines: [],
        triggers: [],
      };
      const target: SchemaSnapshot = {
        tables: [{ name: "users", columns: [col], indexes: [] }],
        views: [],
        routines: [],
        triggers: [],
      };
      const result = compareSchemas(source, target);
      expect(result.tables.identical).toEqual(["users"]);
      expect(result.tables.different).toHaveLength(0);
    });

    it("detects different tables", () => {
      const source: SchemaSnapshot = {
        tables: [{ name: "users", columns: [makeColumn({ name: "id" }), makeColumn({ name: "email" })], indexes: [] }],
        views: [],
        routines: [],
        triggers: [],
      };
      const target: SchemaSnapshot = {
        tables: [{ name: "users", columns: [makeColumn({ name: "id" })], indexes: [] }],
        views: [],
        routines: [],
        triggers: [],
      };
      const result = compareSchemas(source, target);
      expect(result.tables.different).toHaveLength(1);
      expect(result.tables.different[0].name).toBe("users");
      expect(result.tables.different[0].columns.added).toHaveLength(1);
    });

    it("compares views", () => {
      const source: SchemaSnapshot = {
        tables: [],
        views: [{ info: { name: "v_users", is_updatable: false }, ddl: "CREATE VIEW v_users AS SELECT * FROM users" }],
        routines: [],
        triggers: [],
      };
      const target: SchemaSnapshot = {
        tables: [],
        views: [],
        routines: [],
        triggers: [],
      };
      const result = compareSchemas(source, target);
      expect(result.views.onlyInSource).toHaveLength(1);
      expect(result.views.onlyInSource[0].name).toBe("v_users");
    });

    it("detects different views by DDL", () => {
      const source: SchemaSnapshot = {
        tables: [],
        views: [{ info: { name: "v_users", is_updatable: false }, ddl: "CREATE VIEW v_users AS SELECT id, name FROM users" }],
        routines: [],
        triggers: [],
      };
      const target: SchemaSnapshot = {
        tables: [],
        views: [{ info: { name: "v_users", is_updatable: false }, ddl: "CREATE VIEW v_users AS SELECT * FROM users" }],
        routines: [],
        triggers: [],
      };
      const result = compareSchemas(source, target);
      expect(result.views.different).toEqual(["v_users"]);
    });

    it("compares routines", () => {
      const source: SchemaSnapshot = {
        tables: [],
        views: [],
        routines: [{ info: { name: "get_user", routine_type: "FUNCTION", data_type: "varchar" }, ddl: "CREATE FUNCTION get_user() RETURNS varchar(255) BEGIN RETURN 'hello'; END" }],
        triggers: [],
      };
      const target: SchemaSnapshot = {
        tables: [],
        views: [],
        routines: [],
        triggers: [],
      };
      const result = compareSchemas(source, target);
      expect(result.routines.onlyInSource).toHaveLength(1);
    });

    it("detects routines only in target", () => {
      const source: SchemaSnapshot = {
        tables: [],
        views: [],
        routines: [],
        triggers: [],
      };
      const target: SchemaSnapshot = {
        tables: [],
        views: [],
        routines: [{ info: { name: "update_user", routine_type: "PROCEDURE", data_type: "" }, ddl: "CREATE PROCEDURE update_user(IN uid INT) BEGIN UPDATE users SET name = 'x' WHERE id = uid; END" }],
        triggers: [],
      };
      const result = compareSchemas(source, target);
      expect(result.routines.onlyInTarget).toHaveLength(1);
      expect(result.routines.onlyInTarget[0].name).toBe("update_user");
    });

    it("compares triggers", () => {      const source: SchemaSnapshot = {
        tables: [],
        views: [],
        routines: [],
        triggers: [{ info: { name: "trg_users", event: "INSERT", table: "users", timing: "BEFORE" }, ddl: "CREATE TRIGGER trg_users BEFORE INSERT ON users FOR EACH ROW BEGIN END" }],
      };
      const target: SchemaSnapshot = {
        tables: [],
        views: [],
        routines: [],
        triggers: [],
      };
      const result = compareSchemas(source, target);
      expect(result.triggers.onlyInSource).toHaveLength(1);
    });

    it("detects triggers only in target", () => {
      const source: SchemaSnapshot = {
        tables: [],
        views: [],
        routines: [],
        triggers: [],
      };
      const target: SchemaSnapshot = {
        tables: [],
        views: [],
        routines: [],
        triggers: [{ info: { name: "trg_log", event: "INSERT", table: "orders", timing: "AFTER" }, ddl: "CREATE TRIGGER trg_log AFTER INSERT ON orders FOR EACH ROW BEGIN END" }],
      };
      const result = compareSchemas(source, target);
      expect(result.triggers.onlyInTarget).toHaveLength(1);
      expect(result.triggers.onlyInTarget[0].name).toBe("trg_log");
    });

    it("detects identical views", () => {
      const viewDdl = "CREATE VIEW v_users AS SELECT * FROM users";
      const source: SchemaSnapshot = {
        tables: [],
        views: [{ info: { name: "v_users", is_updatable: false }, ddl: viewDdl }],
        routines: [],
        triggers: [],
      };
      const target: SchemaSnapshot = {
        tables: [],
        views: [{ info: { name: "v_users", is_updatable: false }, ddl: viewDdl }],
        routines: [],
        triggers: [],
      };
      const result = compareSchemas(source, target);
      expect(result.views.identical).toEqual(["v_users"]);
      expect(result.views.different).toHaveLength(0);
    });

    it("detects identical routines", () => {
      const ddl = "CREATE FUNCTION get_name() RETURNS varchar(100) BEGIN RETURN 'bob'; END";
      const source: SchemaSnapshot = {
        tables: [],
        views: [],
        routines: [{ info: { name: "get_name", routine_type: "FUNCTION", data_type: "varchar" }, ddl }],
        triggers: [],
      };
      const target: SchemaSnapshot = {
        tables: [],
        views: [],
        routines: [{ info: { name: "get_name", routine_type: "FUNCTION", data_type: "varchar" }, ddl }],
        triggers: [],
      };
      const result = compareSchemas(source, target);
      expect(result.routines.identical).toEqual(["get_name"]);
    });

    it("detects identical triggers", () => {
      const ddl = "CREATE TRIGGER trg_audit BEFORE UPDATE ON users FOR EACH ROW BEGIN END";
      const source: SchemaSnapshot = {
        tables: [],
        views: [],
        routines: [],
        triggers: [{ info: { name: "trg_audit", event: "UPDATE", table: "users", timing: "BEFORE" }, ddl }],
      };
      const target: SchemaSnapshot = {
        tables: [],
        views: [],
        routines: [],
        triggers: [{ info: { name: "trg_audit", event: "UPDATE", table: "users", timing: "BEFORE" }, ddl }],
      };
      const result = compareSchemas(source, target);
      expect(result.triggers.identical).toEqual(["trg_audit"]);
    });

    it("detects views only in target", () => {
      const source: SchemaSnapshot = {
        tables: [],
        views: [],
        routines: [],
        triggers: [],
      };
      const target: SchemaSnapshot = {
        tables: [],
        views: [{ info: { name: "v_orders", is_updatable: false }, ddl: "CREATE VIEW v_orders AS SELECT * FROM orders" }],
        routines: [],
        triggers: [],
      };
      const result = compareSchemas(source, target);
      expect(result.views.onlyInTarget).toHaveLength(1);
      expect(result.views.onlyInTarget[0].name).toBe("v_orders");
    });

    it("includes columns.added in TableDiff when different", () => {
      const source: SchemaSnapshot = {
        tables: [{ name: "items", columns: [makeColumn({ name: "id" }), makeColumn({ name: "sku" })], indexes: [] }],
        views: [],
        routines: [],
        triggers: [],
      };
      const target: SchemaSnapshot = {
        tables: [{ name: "items", columns: [makeColumn({ name: "id" })], indexes: [] }],
        views: [],
        routines: [],
        triggers: [],
      };
      const result = compareSchemas(source, target);
      expect(result.tables.different).toHaveLength(1);
      expect(result.tables.different[0].columns.added).toHaveLength(1);
      expect(result.tables.different[0].columns.added[0].name).toBe("sku");
    });
  });
});
