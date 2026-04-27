import { describe, it, expect } from "vitest";
import { detectContext, parseFromTables } from "../schema-completion-provider";

describe("detectContext", () => {
  it("detects table context after FROM", () => {
    expect(detectContext("SELECT * FROM ")).toBe("table");
  });

  it("detects table context after JOIN", () => {
    expect(detectContext("SELECT * FROM users JOIN ")).toBe("table");
    expect(detectContext("SELECT * FROM users LEFT JOIN ")).toBe("table");
    expect(detectContext("SELECT * FROM users RIGHT OUTER JOIN ")).toBe("table");
    expect(detectContext("SELECT * FROM users CROSS JOIN ")).toBe("table");
  });

  it("detects table context after INTO", () => {
    expect(detectContext("INSERT INTO ")).toBe("table");
  });

  it("detects table context after UPDATE", () => {
    expect(detectContext("UPDATE ")).toBe("table");
  });

  it("detects table context after TRUNCATE", () => {
    expect(detectContext("TRUNCATE ")).toBe("table");
  });

  it("detects table context after DESCRIBE/DESC/EXPLAIN", () => {
    expect(detectContext("DESCRIBE ")).toBe("table");
    expect(detectContext("DESC ")).toBe("table");
    expect(detectContext("EXPLAIN ")).toBe("table");
  });

  it("detects column context after SELECT", () => {
    expect(detectContext("SELECT ")).toBe("column");
    expect(detectContext("SELECT * FROM users SELECT ")).toBe("column");
  });

  it("detects column context after WHERE", () => {
    expect(detectContext("SELECT * FROM users WHERE ")).toBe("column");
  });

  it("detects column context after ON", () => {
    expect(detectContext("SELECT * FROM users JOIN orders ON ")).toBe("column");
  });

  it("detects column context after SET", () => {
    expect(detectContext("UPDATE users SET ")).toBe("column");
  });

  it("detects column context after ORDER BY", () => {
    expect(detectContext("SELECT * FROM users ORDER BY ")).toBe("column");
  });

  it("detects column context after GROUP BY", () => {
    expect(detectContext("SELECT * FROM users GROUP BY ")).toBe("column");
  });

  it("detects column context after HAVING", () => {
    expect(detectContext("SELECT * FROM users HAVING ")).toBe("column");
  });

  it("detects column context after AND/OR", () => {
    expect(detectContext("SELECT * FROM users WHERE id=1 AND ")).toBe("column");
    expect(detectContext("SELECT * FROM users WHERE id=1 OR ")).toBe("column");
  });

  it("detects database context after USE", () => {
    expect(detectContext("USE ")).toBe("database");
  });

  it("detects general context for unknown patterns", () => {
    expect(detectContext("")).toBe("general");
    expect(detectContext("hello world")).toBe("general");
    expect(detectContext("-- comment")).toBe("general");
  });

  it("is case insensitive", () => {
    expect(detectContext("select * from ")).toBe("table");
    expect(detectContext("Select ")).toBe("column");
    expect(detectContext("use ")).toBe("database");
  });
});

describe("parseFromTables", () => {
  it("extracts table from simple SELECT", () => {
    expect(parseFromTables("SELECT * FROM users")).toEqual(["users"]);
  });

  it("extracts multiple tables when JOIN has alias", () => {
    expect(
      parseFromTables("SELECT * FROM users u JOIN orders o"),
    ).toEqual(["users", "orders"]);
  });

  it("extracts table with alias", () => {
    expect(parseFromTables("SELECT * FROM users u")).toEqual(["users"]);
    expect(parseFromTables("SELECT * FROM users AS u")).toEqual(["users"]);
  });

  it("extracts table with database prefix", () => {
    expect(parseFromTables("SELECT * FROM mydb.users")).toEqual(["users"]);
    expect(parseFromTables("SELECT * FROM `mydb`.`users`")).toEqual(["users"]);
  });

  it("extracts backtick-quoted table names", () => {
    expect(parseFromTables("SELECT * FROM `users`")).toEqual(["users"]);
  });

  it("ignores SQL keywords as table names", () => {
    expect(parseFromTables("SELECT * FROM WHERE")).toEqual([]);
    expect(parseFromTables("SELECT * FROM SELECT")).toEqual([]);
  });

  it("deduplicates table names", () => {
    expect(
      parseFromTables("SELECT * FROM users JOIN users AS u2"),
    ).toEqual(["users"]);
  });

  it("handles empty input", () => {
    expect(parseFromTables("")).toEqual([]);
    expect(parseFromTables("SELECT 1")).toEqual([]);
  });

  it("handles complex queries", () => {
    const sql = `
      SELECT u.name, o.total
      FROM users u
      INNER JOIN orders o ON u.id = o.user_id
      LEFT JOIN products p ON o.product_id = p.id
    `;
    expect(parseFromTables(sql)).toEqual(["users", "orders", "products"]);
  });
});
