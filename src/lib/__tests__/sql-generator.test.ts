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

// ── Numeric columns carried as strings (#502) ────────────────────────────
//
// BIGINT and DECIMAL arrive as strings so JSON cannot truncate them, which
// means `typeof value === "number"` no longer identifies a number. Quoting has
// to come from the column type instead.

describe("formatSqlValue with column types", () => {
  it("emits a stringified BIGINT unquoted", () => {
    // 2^53 + 1 — the value JSON.parse cannot represent
    expect(formatSqlValue("9007199254740993", "bigint")).toBe("9007199254740993");
    expect(formatSqlValue("18446744073709551615", "BIGINT UNSIGNED")).toBe("18446744073709551615");
  });

  it("emits a stringified DECIMAL unquoted, keeping every digit", () => {
    expect(formatSqlValue("12345678901234.5678", "DECIMAL(20,4)")).toBe("12345678901234.5678");
  });

  it("still quotes an ordinary string column", () => {
    expect(formatSqlValue("9007199254740993", "varchar(64)")).toBe("'9007199254740993'");
  });

  it("still quotes when the column type is unknown", () => {
    expect(formatSqlValue("42")).toBe("'42'");
  });

  it("quotes a numeric column whose value is not actually a number", () => {
    // Safety: the column type alone must not be enough to unquote, or a
    // mismatch would splice raw text into the statement.
    expect(formatSqlValue("1; DROP TABLE users", "bigint")).toBe("'1; DROP TABLE users'");
    expect(formatSqlValue("", "bigint")).toBe("''");
  });

  it("leaves the existing non-string behaviour alone", () => {
    expect(formatSqlValue(null, "bigint")).toBe("NULL");
    expect(formatSqlValue(42, "bigint")).toBe("42");
    expect(formatSqlValue(true, "tinyint")).toBe("1");
  });
});

describe("generated statements keep BIGINT unquoted", () => {
  const types = { id: "bigint", name: "varchar(20)" };

  it("INSERT", () => {
    expect(generateInsert("t", ["id", "name"], { id: "9007199254740993", name: "x" }, types))
      .toBe("INSERT INTO `t` (`id`, `name`) VALUES (9007199254740993, 'x');");
  });

  it("UPDATE, in both SET and WHERE", () => {
    const sql = generateUpdate(
      "t",
      ["id"],
      { id: "9007199254740993" },
      [{ column: "id", newValue: "9007199254740994" }],
      types,
    );
    expect(sql).toBe(
      "UPDATE `t` SET `id` = 9007199254740994 WHERE `id` = 9007199254740993 LIMIT 1;",
    );
  });

  it("DELETE", () => {
    expect(generateDelete("t", ["id"], { id: "9007199254740993" }, types))
      .toBe("DELETE FROM `t` WHERE `id` = 9007199254740993 LIMIT 1;");
  });

  it("without column types the id would be quoted — the bug this prevents", () => {
    expect(generateDelete("t", ["id"], { id: "9007199254740993" }))
      .toBe("DELETE FROM `t` WHERE `id` = '9007199254740993' LIMIT 1;");
  });
});
