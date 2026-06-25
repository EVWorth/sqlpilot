import { describe, expect, it } from "vitest";
import {
  type CanvasTable,
  generateAlias,
  generateSQL,
  getAllColumnRefs,
  type QueryBuilderState,
} from "../query-builder-engine";

function makeTable(
  overrides: Partial<CanvasTable> & { tableName: string },
): CanvasTable {
  return {
    id: overrides.id ?? "t1",
    tableName: overrides.tableName,
    alias: overrides.alias ?? overrides.tableName,
    columns: overrides.columns ?? [
      {
        name: "id",
        data_type: "int",
        column_type: "int(11)",
        nullable: false,
        is_primary_key: true,
        extra: "",
        comment: "",
      },
      {
        name: "name",
        data_type: "varchar",
        column_type: "varchar(255)",
        nullable: true,
        is_primary_key: false,
        extra: "",
        comment: "",
      },
    ],
    selectedColumns: overrides.selectedColumns ?? [],
    aggregates: overrides.aggregates ?? {},
    position: overrides.position ?? { x: 0, y: 0 },
  };
}

function makeState(overrides: Partial<QueryBuilderState>): QueryBuilderState {
  return {
    tables: overrides.tables ?? [],
    joins: overrides.joins ?? [],
    where: overrides.where ?? [],
    orderBy: overrides.orderBy ?? [],
    groupBy: overrides.groupBy ?? [],
    having: overrides.having ?? [],
    limit: overrides.limit ?? null,
  };
}

describe("query-builder-engine", () => {
  describe("generateSQL", () => {
    it("returns empty string with no tables", () => {
      expect(generateSQL(makeState({}))).toBe("");
    });

    it("generates SELECT * for table with no selected columns", () => {
      const sql = generateSQL(
        makeState({
          tables: [makeTable({ tableName: "users" })],
        }),
      );
      expect(sql).toContain("SELECT *");
      expect(sql).toContain("FROM `users` AS `users`");
    });

    it("generates SELECT with specific columns", () => {
      const sql = generateSQL(
        makeState({
          tables: [
            makeTable({
              tableName: "users",
              selectedColumns: ["id", "name"],
            }),
          ],
        }),
      );
      expect(sql).toContain("`users`.`id`");
      expect(sql).toContain("`users`.`name`");
      expect(sql).not.toContain("SELECT *");
    });

    it("generates SELECT with aggregate functions", () => {
      const sql = generateSQL(
        makeState({
          tables: [
            makeTable({
              tableName: "orders",
              selectedColumns: ["id", "name"],
              aggregates: { id: "COUNT" },
            }),
          ],
        }),
      );
      expect(sql).toContain("COUNT(`orders`.`id`)");
      expect(sql).toContain("`orders`.`name`");
    });

    it("generates INNER JOIN", () => {
      const sql = generateSQL(
        makeState({
          tables: [
            makeTable({ id: "t1", tableName: "users" }),
            makeTable({ id: "t2", tableName: "orders" }),
          ],
          joins: [
            {
              id: "j1",
              leftTableId: "t1",
              leftColumn: "id",
              rightTableId: "t2",
              rightColumn: "user_id",
              joinType: "INNER",
            },
          ],
        }),
      );
      expect(sql).toContain("INNER JOIN `orders` AS `orders`");
      expect(sql).toContain(
        "ON `users`.`id` = `orders`.`user_id`",
      );
    });

    it("generates LEFT JOIN", () => {
      const sql = generateSQL(
        makeState({
          tables: [
            makeTable({ id: "t1", tableName: "users" }),
            makeTable({ id: "t2", tableName: "orders" }),
          ],
          joins: [
            {
              id: "j1",
              leftTableId: "t1",
              leftColumn: "id",
              rightTableId: "t2",
              rightColumn: "user_id",
              joinType: "LEFT",
            },
          ],
        }),
      );
      expect(sql).toContain("LEFT JOIN");
    });

    it("generates WHERE with equality", () => {
      const sql = generateSQL(
        makeState({
          tables: [makeTable({ tableName: "users" })],
          where: [
            {
              id: "w1",
              column: "`users`.`name`",
              operator: "=",
              value: "Alice",
              logic: "AND",
            },
          ],
        }),
      );
      expect(sql).toContain("WHERE `users`.`name` = 'Alice'");
    });

    it("generates WHERE with numeric value (unquoted)", () => {
      const sql = generateSQL(
        makeState({
          tables: [makeTable({ tableName: "users" })],
          where: [
            {
              id: "w1",
              column: "`users`.`id`",
              operator: ">",
              value: "42",
              logic: "AND",
            },
          ],
        }),
      );
      expect(sql).toContain("WHERE `users`.`id` > 42");
    });

    it("generates WHERE with IS NULL", () => {
      const sql = generateSQL(
        makeState({
          tables: [makeTable({ tableName: "users" })],
          where: [
            {
              id: "w1",
              column: "`users`.`name`",
              operator: "IS NULL",
              value: "",
              logic: "AND",
            },
          ],
        }),
      );
      expect(sql).toContain("WHERE `users`.`name` IS NULL");
    });

    it("generates WHERE with LIKE", () => {
      const sql = generateSQL(
        makeState({
          tables: [makeTable({ tableName: "users" })],
          where: [
            {
              id: "w1",
              column: "`users`.`name`",
              operator: "LIKE",
              value: "%test%",
              logic: "AND",
            },
          ],
        }),
      );
      expect(sql).toContain("WHERE `users`.`name` LIKE '%test%'");
    });

    it("generates WHERE with multiple conditions and AND/OR", () => {
      const sql = generateSQL(
        makeState({
          tables: [makeTable({ tableName: "users" })],
          where: [
            {
              id: "w1",
              column: "`users`.`id`",
              operator: ">",
              value: "10",
              logic: "AND",
            },
            {
              id: "w2",
              column: "`users`.`name`",
              operator: "=",
              value: "Bob",
              logic: "OR",
            },
          ],
        }),
      );
      expect(sql).toContain("WHERE `users`.`id` > 10");
      expect(sql).toContain("OR `users`.`name` = 'Bob'");
    });

    it("generates ORDER BY", () => {
      const sql = generateSQL(
        makeState({
          tables: [
            makeTable({
              tableName: "users",
              selectedColumns: ["id"],
            }),
          ],
          orderBy: [
            { id: "o1", column: "`users`.`id`", direction: "DESC" },
          ],
        }),
      );
      expect(sql).toContain("ORDER BY `users`.`id` DESC");
    });

    it("generates GROUP BY", () => {
      const sql = generateSQL(
        makeState({
          tables: [
            makeTable({
              tableName: "users",
              selectedColumns: ["name"],
            }),
          ],
          groupBy: ["`users`.`name`"],
        }),
      );
      expect(sql).toContain("GROUP BY `users`.`name`");
    });

    it("generates HAVING with GROUP BY", () => {
      const sql = generateSQL(
        makeState({
          tables: [
            makeTable({
              tableName: "users",
              selectedColumns: ["name", "id"],
              aggregates: { id: "COUNT" },
            }),
          ],
          groupBy: ["`users`.`name`"],
          having: [
            {
              id: "h1",
              column: "COUNT(`users`.`id`)",
              operator: ">",
              value: "5",
              logic: "AND",
            },
          ],
        }),
      );
      expect(sql).toContain("HAVING COUNT(`users`.`id`) > 5");
    });

    it("does not generate HAVING without GROUP BY", () => {
      const sql = generateSQL(
        makeState({
          tables: [makeTable({ tableName: "users" })],
          having: [
            {
              id: "h1",
              column: "COUNT(`users`.`id`)",
              operator: ">",
              value: "5",
              logic: "AND",
            },
          ],
        }),
      );
      expect(sql).not.toContain("HAVING");
    });

    it("generates LIMIT", () => {
      const sql = generateSQL(
        makeState({
          tables: [makeTable({ tableName: "users" })],
          limit: 100,
        }),
      );
      expect(sql).toContain("LIMIT 100");
    });

    it("handles table aliasing for duplicate tables", () => {
      const sql = generateSQL(
        makeState({
          tables: [
            makeTable({ id: "t1", tableName: "users", alias: "users" }),
            makeTable({ id: "t2", tableName: "users", alias: "users_2" }),
          ],
          joins: [
            {
              id: "j1",
              leftTableId: "t1",
              leftColumn: "manager_id",
              rightTableId: "t2",
              rightColumn: "id",
              joinType: "INNER",
            },
          ],
        }),
      );
      expect(sql).toContain("FROM `users` AS `users`");
      expect(sql).toContain("INNER JOIN `users` AS `users_2`");
    });

    it("escapes single quotes in string values", () => {
      const sql = generateSQL(
        makeState({
          tables: [makeTable({ tableName: "users" })],
          where: [
            {
              id: "w1",
              column: "`users`.`name`",
              operator: "=",
              value: "O'Brien",
              logic: "AND",
            },
          ],
        }),
      );
      expect(sql).toContain("'O''Brien'");
    });

    it("generates complete query with all clauses", () => {
      const sql = generateSQL(
        makeState({
          tables: [
            makeTable({
              id: "t1",
              tableName: "users",
              selectedColumns: ["name", "id"],
              aggregates: { id: "COUNT" },
            }),
            makeTable({ id: "t2", tableName: "orders" }),
          ],
          joins: [
            {
              id: "j1",
              leftTableId: "t1",
              leftColumn: "id",
              rightTableId: "t2",
              rightColumn: "user_id",
              joinType: "LEFT",
            },
          ],
          where: [
            {
              id: "w1",
              column: "`users`.`name`",
              operator: "!=",
              value: "admin",
              logic: "AND",
            },
          ],
          groupBy: ["`users`.`name`"],
          having: [
            {
              id: "h1",
              column: "COUNT(`users`.`id`)",
              operator: ">=",
              value: "2",
              logic: "AND",
            },
          ],
          orderBy: [
            { id: "o1", column: "`users`.`name`", direction: "ASC" },
          ],
          limit: 50,
        }),
      );
      expect(sql).toContain("SELECT");
      expect(sql).toContain("COUNT(`users`.`id`)");
      expect(sql).toContain("FROM `users`");
      expect(sql).toContain("LEFT JOIN `orders`");
      expect(sql).toContain("WHERE");
      expect(sql).toContain("GROUP BY");
      expect(sql).toContain("HAVING");
      expect(sql).toContain("ORDER BY");
      expect(sql).toContain("LIMIT 50");
    });
  });

  describe("generateAlias", () => {
    it("returns table name when no duplicates", () => {
      expect(generateAlias("users", [])).toBe("users");
    });

    it("returns table_2 for second instance", () => {
      const existing = [makeTable({ tableName: "users" })];
      expect(generateAlias("users", existing)).toBe("users_2");
    });

    it("returns table_3 for third instance", () => {
      const existing = [
        makeTable({ id: "t1", tableName: "users", alias: "users" }),
        makeTable({ id: "t2", tableName: "users", alias: "users_2" }),
      ];
      expect(generateAlias("users", existing)).toBe("users_3");
    });
  });

  describe("getAllColumnRefs", () => {
    it("returns refs for all columns in all tables", () => {
      const tables = [
        makeTable({ id: "t1", tableName: "users" }),
        makeTable({ id: "t2", tableName: "orders" }),
      ];
      const refs = getAllColumnRefs(tables);
      expect(refs).toHaveLength(4); // 2 columns x 2 tables
      expect(refs[0].label).toBe("users.id");
      expect(refs[0].ref).toBe("`users`.`id`");
    });
  });
});
