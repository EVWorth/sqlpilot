import { describe, expect, it } from "vitest";
import type { QueryResult } from "../../../types";
import { buildTree, parseExplainRows, referencedIds } from "../ExplainPanel";

/**
 * Rows below are transcribed from real `EXPLAIN` output on MySQL 8 rather than
 * invented — the shape of a UNION plan is exactly what #423 got wrong.
 */
const COLUMNS = [
  "id",
  "select_type",
  "table",
  "partitions",
  "type",
  "possible_keys",
  "key",
  "key_len",
  "ref",
  "rows",
  "filtered",
  "Extra",
].map((name) => ({
  name,
  data_type: "varchar",
  nullable: true,
  is_primary_key: false,
}));

function explain(rows: (string | number | null)[][]): QueryResult {
  return {
    query_id: "q",
    statement_index: 0,
    columns: COLUMNS,
    rows: rows.map((r) => [...r, ...Array(12 - r.length).fill(null)]),
    rows_affected: 0,
    execution_time_ms: 1,
    warnings: [],
    rows_truncated: false,
  } as QueryResult;
}

/** Compact shape of a tree, for readable assertions. */
function shape(nodes: ReturnType<typeof buildTree>): unknown {
  return nodes.map((n) => ({
    label: n.table || n.selectType,
    children: n.children.length ? shape(n.children) : undefined,
  }));
}

function treeOf(rows: (string | number | null)[][]) {
  return shape(buildTree(parseExplainRows(explain(rows))));
}

describe("referencedIds", () => {
  it("reads the members of a UNION RESULT", () => {
    expect(referencedIds("<union1,2>")).toEqual([1, 2]);
    expect(referencedIds("<union2,3,4>")).toEqual([2, 3, 4]);
  });

  it("reads a derived or materialised subquery reference", () => {
    expect(referencedIds("<derived2>")).toEqual([2]);
    expect(referencedIds("<subquery3>")).toEqual([3]);
  });

  it("reads a plain table name as no reference", () => {
    expect(referencedIds("users")).toEqual([]);
    expect(referencedIds("")).toEqual([]);
    // Not a synthetic name, just an oddly named table.
    expect(referencedIds("union_log")).toEqual([]);
  });
});

describe("buildTree", () => {
  it("keeps a single row at the root", () => {
    expect(treeOf([[1, "SIMPLE", "users", null, "ALL"]])).toEqual([
      { label: "users", children: undefined },
    ]);
  });

  it("keeps the tables of one join as siblings", () => {
    // Same id means one SELECT block: this is join order, not nesting.
    expect(
      treeOf([
        [1, "SIMPLE", "o", null, "ALL"],
        [1, "SIMPLE", "u", null, "eq_ref"],
      ]),
    ).toEqual([
      { label: "o", children: undefined },
      { label: "u", children: undefined },
    ]);
  });

  it("nests a UNION under its UNION RESULT", () => {
    // The case #423 reported: these used to render as flat, unrelated nodes.
    expect(
      treeOf([
        [1, "PRIMARY", "", null, null],
        [2, "UNION", "", null, null],
        [3, "UNION RESULT", "<union1,2>", null, "ALL"],
      ]),
    ).toEqual([
      {
        label: "<union1,2>",
        children: [
          { label: "PRIMARY", children: undefined },
          { label: "UNION", children: undefined },
        ],
      },
    ]);
  });

  it("nests a UNION RESULT that carries no id of its own", () => {
    // MySQL 5.7 leaves the UNION RESULT row's id NULL.
    expect(
      treeOf([
        [1, "PRIMARY", "users", null, "index"],
        [2, "UNION", "users", null, "index"],
        [null, "UNION RESULT", "<union1,2>", null, "ALL"],
      ]),
    ).toEqual([
      {
        label: "<union1,2>",
        children: [
          { label: "users", children: undefined },
          { label: "users", children: undefined },
        ],
      },
    ]);
  });

  it("nests a subquery under the query that contains it", () => {
    expect(
      treeOf([
        [1, "PRIMARY", "users", null, "ALL"],
        [2, "SUBQUERY", "orders", null, "index"],
      ]),
    ).toEqual([
      {
        label: "users",
        children: [{ label: "orders", children: undefined }],
      },
    ]);
  });

  it("nests a union inside a subquery correctly", () => {
    // Real MySQL 8 output for:
    //   SELECT id FROM users
    //   WHERE id IN (SELECT user_id FROM orders UNION SELECT id FROM users)
    expect(
      treeOf([
        [1, "PRIMARY", "users", null, "index"],
        [2, "DEPENDENT SUBQUERY", "orders", null, "ref"],
        [3, "DEPENDENT UNION", "users", null, "eq_ref"],
        [4, "UNION RESULT", "<union2,3>", null, "ALL"],
      ]),
    ).toEqual([
      {
        label: "users",
        children: [
          {
            label: "<union2,3>",
            children: [
              { label: "orders", children: undefined },
              { label: "users", children: undefined },
            ],
          },
        ],
      },
    ]);
  });

  it("renders every row exactly once", () => {
    // A row claimed by a UNION RESULT must not also be placed by the id
    // ordering fallback.
    const tree = buildTree(
      parseExplainRows(
        explain([
          [1, "PRIMARY", "a", null, "ALL"],
          [2, "DEPENDENT SUBQUERY", "b", null, "ref"],
          [3, "DEPENDENT UNION", "c", null, "eq_ref"],
          [4, "UNION RESULT", "<union2,3>", null, "ALL"],
        ]),
      ),
    );
    const labels: string[] = [];
    const walk = (nodes: typeof tree) => {
      for (const n of nodes) {
        labels.push(n.table || n.selectType);
        walk(n.children);
      }
    };
    walk(tree);
    expect(labels.sort()).toEqual(["<union2,3>", "a", "b", "c"]);
  });

  it("returns an empty tree for no rows", () => {
    expect(treeOf([])).toEqual([]);
  });
});
