import { describe, expect, it } from "vitest";
import type { ColumnMeta } from "../../types";
import {
  extractTableName,
  formatSqlValue,
  generateDelete,
  generateInsert,
  generateUpdate,
  getPrimaryKeyColumns,
  getWhereColumns,
} from "../sql-generator";

describe("sql-generator", () => {
  describe("formatSqlValue", () => {
    it("formats null", () => {
      expect(formatSqlValue(null)).toBe("NULL");
    });
    it("formats undefined as NULL", () => {
      expect(formatSqlValue(undefined)).toBe("NULL");
    });
    it("formats boolean true", () => {
      expect(formatSqlValue(true)).toBe("1");
    });
    it("formats boolean false", () => {
      expect(formatSqlValue(false)).toBe("0");
    });
    it("formats numbers", () => {
      expect(formatSqlValue(42)).toBe("42");
      expect(formatSqlValue(3.14)).toBe("3.14");
    });
    it("formats strings with quote escaping", () => {
      expect(formatSqlValue("hello")).toBe("'hello'");
      expect(formatSqlValue("it's")).toBe("'it''s'");
    });
  });

  describe("generateUpdate", () => {
    it("generates an UPDATE statement", () => {
      const result = generateUpdate(
        "users",
        ["id"],
        { id: 1, name: "Alice", email: "a@b.com" },
        [{ column: "name", newValue: "Bob" }],
      );
      expect(result).toBe(
        "UPDATE `users` SET `name` = 'Bob' WHERE `id` = 1 LIMIT 1;",
      );
    });

    it("handles NULL in WHERE clause", () => {
      const result = generateUpdate(
        "users",
        ["id"],
        { id: null, name: "Alice" },
        [{ column: "name", newValue: "Bob" }],
      );
      expect(result).toContain("`id` IS NULL");
    });

    it("handles multiple changes", () => {
      const result = generateUpdate(
        "users",
        ["id"],
        { id: 1, name: "Alice", email: "a@b.com" },
        [
          { column: "name", newValue: "Bob" },
          { column: "email", newValue: "bob@x.com" },
        ],
      );
      expect(result).toContain("`name` = 'Bob'");
      expect(result).toContain("`email` = 'bob@x.com'");
    });
  });

  describe("generateInsert", () => {
    it("generates an INSERT statement", () => {
      const result = generateInsert("users", ["id", "name"], {
        id: 1,
        name: "Alice",
      });
      expect(result).toBe(
        "INSERT INTO `users` (`id`, `name`) VALUES (1, 'Alice');",
      );
    });

    it("skips undefined columns", () => {
      const result = generateInsert("users", ["id", "name", "email"], {
        name: "Alice",
      });
      expect(result).toBe("INSERT INTO `users` (`name`) VALUES ('Alice');");
    });

    it("handles NULL values", () => {
      const result = generateInsert("users", ["id", "name"], {
        id: 1,
        name: null,
      });
      expect(result).toContain("NULL");
    });
  });

  describe("generateDelete", () => {
    it("generates a DELETE statement", () => {
      const result = generateDelete("users", ["id"], { id: 1, name: "Alice" });
      expect(result).toBe(
        "DELETE FROM `users` WHERE `id` = 1 LIMIT 1;",
      );
    });

    it("uses composite primary key", () => {
      const result = generateDelete("user_roles", ["user_id", "role_id"], {
        user_id: 1,
        role_id: 2,
      });
      expect(result).toContain("`user_id` = 1 AND `role_id` = 2");
    });
  });

  describe("extractTableName", () => {
    it("extracts from simple SELECT", () => {
      expect(extractTableName("SELECT * FROM users")).toBe("users");
    });
    it("extracts backtick-quoted table", () => {
      expect(extractTableName("SELECT * FROM `my_table`")).toBe("my_table");
    });
    it("extracts from complex query", () => {
      expect(
        extractTableName("SELECT id, name FROM users WHERE id > 5"),
      ).toBe("users");
    });
    it("returns null for non-SELECT", () => {
      expect(extractTableName("SHOW TABLES")).toBeNull();
    });
    it("is case-insensitive", () => {
      expect(extractTableName("select * from Users")).toBe("Users");
    });
  });

  describe("getPrimaryKeyColumns", () => {
    it("returns PK columns", () => {
      const cols: ColumnMeta[] = [
        { name: "id", data_type: "int", nullable: false, is_primary_key: true },
        {
          name: "name",
          data_type: "varchar",
          nullable: true,
          is_primary_key: false,
        },
      ];
      expect(getPrimaryKeyColumns(cols)).toEqual(["id"]);
    });
    it("returns empty array when no PKs", () => {
      const cols: ColumnMeta[] = [
        {
          name: "name",
          data_type: "varchar",
          nullable: true,
          is_primary_key: false,
        },
      ];
      expect(getPrimaryKeyColumns(cols)).toEqual([]);
    });
  });

  describe("getWhereColumns", () => {
    it("uses PKs when available", () => {
      const cols: ColumnMeta[] = [
        { name: "id", data_type: "int", nullable: false, is_primary_key: true },
        {
          name: "name",
          data_type: "varchar",
          nullable: true,
          is_primary_key: false,
        },
      ];
      const result = getWhereColumns(cols);
      expect(result.columns).toEqual(["id"]);
      expect(result.hasPrimaryKey).toBe(true);
    });

    it("falls back to all columns when no PK", () => {
      const cols: ColumnMeta[] = [
        {
          name: "a",
          data_type: "int",
          nullable: false,
          is_primary_key: false,
        },
        {
          name: "b",
          data_type: "varchar",
          nullable: true,
          is_primary_key: false,
        },
      ];
      const result = getWhereColumns(cols);
      expect(result.columns).toEqual(["a", "b"]);
      expect(result.hasPrimaryKey).toBe(false);
    });
  });
});
