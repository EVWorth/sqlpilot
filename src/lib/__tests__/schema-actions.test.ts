import { describe, expect, it } from "vitest";
import type { ColumnInfo } from "../../types";
import {
  createDatabase,
  databaseStatistics,
  dropDatabase,
  dropTable,
  duplicateTableStructure,
  insertTemplate,
  isValidObjectName,
  qualified,
  renameTable,
  selectTopRows,
  selectTopRowsLabel,
  truncateTable,
} from "../schema-actions";

const column = (name: string, over: Partial<ColumnInfo> = {}): ColumnInfo => ({
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
});

describe("schema-actions (#293)", () => {
  describe("qualified", () => {
    it("names both halves, so no USE is needed", () => {
      expect(qualified("shop", "orders")).toBe("`shop`.`orders`");
    });

    it("survives a name that needs quoting", () => {
      // The difference between a table called `order details` working and not.
      expect(qualified("my db", "order details")).toBe("`my db`.`order details`");
      expect(qualified("a`b", "c`d")).toBe("`a``b`.`c``d`");
    });
  });

  describe("select top rows", () => {
    it("uses the configured limit, and says so", () => {
      // The menu said "Select Top 100 Rows" while using maxResultRows, which
      // defaults to 1000 — wrong out of the box and wrong again for anyone
      // who changed it.
      expect(selectTopRows("shop", "orders", 1000))
        .toBe("SELECT * FROM `shop`.`orders` LIMIT 1000");
      expect(selectTopRowsLabel(1000)).toBe("Select Top 1,000 Rows");
      expect(selectTopRowsLabel(100)).toBe("Select Top 100 Rows");
    });
  });

  describe("insertTemplate", () => {
    it("names every column and leaves a placeholder per value", () => {
      const sql = insertTemplate("shop", "orders", [column("id"), column("total")]);
      expect(sql).toContain("INSERT INTO `shop`.`orders` (`id`, `total`)");
      expect(sql.match(/NULL/g)).toHaveLength(2);
    });

    it("says what type each value should be", () => {
      // A template whose every value reads `?` tells you nothing.
      const sql = insertTemplate("shop", "orders", [
        column("total", { column_type: "decimal(10,2)" }),
        column("note", { column_type: "varchar(255)", nullable: true }),
      ]);
      expect(sql).toContain("total: decimal(10,2)");
      expect(sql).toContain("note: varchar(255), nullable");
    });

    it("leaves out a generated column, which cannot be assigned", () => {
      // Including it produces a template the server rejects.
      const sql = insertTemplate("shop", "orders", [
        column("id"),
        column("total_with_tax", { extra: "VIRTUAL GENERATED" }),
      ]);
      expect(sql).toContain("`id`");
      expect(sql).not.toContain("total_with_tax");
    });

    it("keeps a column that merely has a default", () => {
      const sql = insertTemplate("shop", "orders", [
        column("created_at", { extra: "DEFAULT_GENERATED" as string }),
      ]);
      // `DEFAULT_GENERATED` is not a generated column — it is a default
      // expression, and the column is still assignable.
      expect(sql).toContain("created_at");
    });

    it("produces something valid for a table with nothing assignable", () => {
      expect(insertTemplate("shop", "t", [])).toBe("INSERT INTO `shop`.`t` () VALUES ();");
    });
  });

  describe("statements", () => {
    it("truncates", () => {
      expect(truncateTable("shop", "orders")).toBe("TRUNCATE TABLE `shop`.`orders`");
    });

    it("renames within the same database", () => {
      // RENAME TABLE takes a qualified destination, so the statement says
      // where the table lands rather than depending on the session.
      expect(renameTable("shop", "orders", "orders_old"))
        .toBe("RENAME TABLE `shop`.`orders` TO `shop`.`orders_old`");
    });

    it("duplicates structure with LIKE, not AS SELECT", () => {
      // AS SELECT silently drops indexes and column attributes.
      const sql = duplicateTableStructure("shop", "orders", "orders_copy");
      expect(sql).toBe("CREATE TABLE `shop`.`orders_copy` LIKE `shop`.`orders`");
      expect(sql).not.toContain("SELECT");
    });

    it("drops a table and a database", () => {
      expect(dropTable("shop", "orders")).toBe("DROP TABLE `shop`.`orders`");
      expect(dropDatabase("shop")).toBe("DROP DATABASE `shop`");
    });
  });

  describe("createDatabase", () => {
    it("leaves charset and collation to the server when not given", () => {
      // Guessing one would silently disagree with the rest of the server.
      expect(createDatabase("shop")).toBe("CREATE DATABASE `shop`");
    });

    it("sets them when they are", () => {
      expect(createDatabase("shop", "utf8mb4", "utf8mb4_0900_ai_ci"))
        .toBe("CREATE DATABASE `shop` CHARACTER SET `utf8mb4` COLLATE `utf8mb4_0900_ai_ci`");
    });

    it("quotes a name that needs it", () => {
      expect(createDatabase("my db")).toBe("CREATE DATABASE `my db`");
    });
  });

  describe("databaseStatistics", () => {
    it("reads information_schema rather than counting rows", () => {
      // Counting every row of every table to fill a context-menu item is not
      // a thing to do to a production server.
      const sql = databaseStatistics("shop");
      expect(sql).toContain("information_schema.TABLES");
      expect(sql).toContain("'shop'");
      expect(sql).not.toMatch(/COUNT\(\*\)/i);
    });

    it("escapes a quote in the database name", () => {
      expect(databaseStatistics("we'ird")).toContain("'we''ird'");
    });

    it("says the row count is approximate in the column header", () => {
      expect(databaseStatistics("shop")).toContain("Rows (approx)");
    });
  });

  describe("isValidObjectName", () => {
    it.each(["users", "order details", "a-b", "ünïcode"])("accepts %s", (name) => {
      expect(isValidObjectName(name)).toBe(true);
    });

    it.each([
      ["nothing", ""],
      ["only spaces", "   "],
      ["a newline", "a\nb"],
      ["a null byte", "a\0b"],
      ["more than 64 characters", "x".repeat(65)],
    ])("rejects %s", (_why, name) => {
      expect(isValidObjectName(name)).toBe(false);
    });
  });
});
