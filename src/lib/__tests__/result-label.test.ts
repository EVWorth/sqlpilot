import { describe, expect, it } from "vitest";
import type { QueryResult } from "../../types";
import { firstGridIndex, resultLabel, statementLabel } from "../result-label";

const result = (over: Partial<QueryResult>): QueryResult =>
  ({
    query_id: "q",
    statement_index: 0,
    sql: "SELECT 1",
    columns: [],
    rows: [],
    rows_affected: 0,
    execution_time_ms: 1,
    warnings: [],
    rows_truncated: false,
    truncation_reason: null,
    total_rows_available: null,
    ...over,
  }) as QueryResult;

const col = { name: "id", data_type: "int", nullable: false, is_primary_key: false };

describe("statementLabel", () => {
  it.each([
    ["SELECT * FROM products;", "SELECT products"],
    ["update `shop`.`products` set price = 1", "UPDATE shop.products"],
    ["INSERT INTO orders (id) VALUES (1)", "INSERT orders"],
    ["DELETE FROM t WHERE id = 1", "DELETE t"],
    ["-- note\nSELECT 1", "SELECT"],
    ["/* x */ SHOW TABLES", "SHOW"],
    ["", "Statement"],
  ])("labels %j as %j", (sql, label) => {
    expect(statementLabel(sql)).toBe(label);
  });
});

describe("resultLabel", () => {
  it("counts rows for a result with columns", () => {
    expect(resultLabel(result({ sql: "SELECT * FROM p", columns: [col], rows: [[1], [2]] }), 0)).toBe(
      "SELECT p · 2 rows",
    );
  });

  it("counts affected rows for a write", () => {
    expect(resultLabel(result({ sql: "UPDATE p SET x = 1", rows_affected: 1 }), 0)).toBe("UPDATE p · 1 affected");
  });
});

describe("firstGridIndex", () => {
  it("picks the first result that has a grid", () => {
    expect(firstGridIndex([result({}), result({ columns: [col] })])).toBe(1);
  });

  it("falls back to the first when none has one", () => {
    expect(firstGridIndex([result({}), result({})])).toBe(0);
  });
});
