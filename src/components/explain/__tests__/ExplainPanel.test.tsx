import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { QueryResult } from "../../types";
import { ExplainPanel } from "../ExplainPanel";

const { useResultStoreFn } = vi.hoisted(() => {
  return { useResultStoreFn: vi.fn() };
});

vi.mock("../../../stores/resultStore", () => ({
  useResultStore: useResultStoreFn,
}));

vi.mock("lucide-react", async () => {
  const actual = await vi.importActual("lucide-react");
  return actual;
});

// Minimal valid EXPLAIN result
function makeExplainResult(rows: (string | number | null)[][], extra: string[] = []): QueryResult {
  const columns = [
    { name: "id", data_type: "bigint", nullable: true, is_primary_key: false },
    { name: "select_type", data_type: "varchar", nullable: true, is_primary_key: false },
    { name: "table", data_type: "varchar", nullable: true, is_primary_key: false },
    { name: "partitions", data_type: "varchar", nullable: true, is_primary_key: false },
    { name: "type", data_type: "varchar", nullable: true, is_primary_key: false },
    { name: "possible_keys", data_type: "varchar", nullable: true, is_primary_key: false },
    { name: "key", data_type: "varchar", nullable: true, is_primary_key: false },
    { name: "key_len", data_type: "varchar", nullable: true, is_primary_key: false },
    { name: "ref", data_type: "varchar", nullable: true, is_primary_key: false },
    { name: "rows", data_type: "bigint", nullable: true, is_primary_key: false },
    { name: "filtered", data_type: "float", nullable: true, is_primary_key: false },
    { name: "Extra", data_type: "varchar", nullable: true, is_primary_key: false },
  ];
  return {
    query_id: "explain-1",
    statement_index: 0,
    columns,
    rows: rows.map((row, i) => {
      // Pad row with Extra and remaining defaults
      const fullRow = [...row, ...Array(12 - row.length).fill(null)];
      if (extra[i]) fullRow[11] = extra[i];
      // Ensure type is at index 4 for coloring
      return fullRow;
    }),
    rows_affected: 0,
    execution_time_ms: 5,
    warnings: [],
    rows_truncated: false,
  };
}

const baseExplainRow = [1, "SIMPLE", "users", null, "ALL", null, null, null, null, 1000, 100.0];

describe("ExplainPanel", () => {
  describe("empty state", () => {
    it("shows empty state when no explain result", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({ explainResult: null, explainAnalyze: false })
      );
      render(<ExplainPanel />);
      expect(screen.getByText("Run EXPLAIN to see the execution plan")).toBeInTheDocument();
    });
  });

  describe("EXPLAIN table view", () => {
    it("renders EXPLAIN label and toggle buttons", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([[...baseExplainRow]]),
          explainAnalyze: false,
        })
      );
      render(<ExplainPanel />);
      expect(screen.getByText("EXPLAIN")).toBeInTheDocument();
      expect(screen.getByText("Table")).toBeInTheDocument();
      expect(screen.getByText("Tree")).toBeInTheDocument();
    });

    it("renders access type legend", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([[...baseExplainRow]]),
          explainAnalyze: false,
        })
      );
      render(<ExplainPanel />);
      expect(screen.getByText("Access type:")).toBeInTheDocument();
      expect(screen.getByText(/worst.*best/)).toBeInTheDocument();
    });

    it("renders column headers in table view", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([[...baseExplainRow]]),
          explainAnalyze: false,
        })
      );
      render(<ExplainPanel />);
      expect(screen.getByText("id")).toBeInTheDocument();
      expect(screen.getByText("select_type")).toBeInTheDocument();
      expect(screen.getByText("table")).toBeInTheDocument();
      expect(screen.getByText("type")).toBeInTheDocument();
      expect(screen.getByText("possible_keys")).toBeInTheDocument();
      expect(screen.getByText("key")).toBeInTheDocument();
      expect(screen.getByText("Extra")).toBeInTheDocument();
    });

    it("renders data rows in table view", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([
            [1, "SIMPLE", "users", null, "ALL", null, null, null, null, 1000, 100.0],
          ]),
          explainAnalyze: false,
        })
      );
      render(<ExplainPanel />);
      expect(screen.getByText("SIMPLE")).toBeInTheDocument();
      expect(screen.getByText("users")).toBeInTheDocument();
      expect(screen.getByText("1,000")).toBeInTheDocument();
    });

    it("shows type badge with correct color for ALL (red)", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([[...baseExplainRow]], []),
          explainAnalyze: false,
        })
      );
      render(<ExplainPanel />);
      const allBadges = screen.getAllByText("ALL");
      const dataBadge = allBadges.find((el) => el.className.includes("inline-block"));
      expect(dataBadge).toBeTruthy();
      expect(dataBadge!.className).toContain("bg-red");
    });

    it("shows type badge for ref (green)", () => {
      const row = [1, "SIMPLE", "orders", null, "ref", "idx_user_id", "idx_user_id", "4", "const", 10, 100.0];
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([row]),
          explainAnalyze: false,
        })
      );
      render(<ExplainPanel />);
      const refBadges = screen.getAllByText("ref");
      const dataBadge = refBadges.find((el) => el.className.includes("inline-block"));
      expect(dataBadge).toBeTruthy();
      expect(dataBadge!.className).toContain("bg-green");
    });
  });

  describe("EXPLAIN tree view", () => {
    it("switches to tree view when Tree button clicked", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([[...baseExplainRow]]),
          explainAnalyze: false,
        })
      );
      render(<ExplainPanel />);
      fireEvent.click(screen.getByText("Tree"));
      // Tree view shows table name in bold
      expect(screen.getByText("users")).toBeInTheDocument();
    });

    it("tree view shows table name and type badge", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([[...baseExplainRow]]),
          explainAnalyze: false,
        })
      );
      render(<ExplainPanel />);
      fireEvent.click(screen.getByText("Tree"));
      expect(screen.getByText("users")).toBeInTheDocument();
      const allBadges = screen.getAllByText("ALL");
      const treeBadge = allBadges.find((el) => el.className.includes("inline-block"));
      expect(treeBadge).toBeTruthy();
    });
  });

  describe("EXPLAIN ANALYZE view", () => {
    it("shows EXPLAIN ANALYZE header when explainAnalyze is true", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([[
            "-> Nested loop inner join  (cost=2.50 rows=100) (actual time=0.125..1.234 rows=100 loops=1)",
          ]]),
          explainAnalyze: true,
        })
      );
      render(<ExplainPanel />);
      expect(screen.getByText("EXPLAIN ANALYZE")).toBeInTheDocument();
    });

    it("renders ANALYZE text content", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([["-> Table scan on users  (cost=2.50 rows=100)"]]),
          explainAnalyze: true,
        })
      );
      render(<ExplainPanel />);
      expect(screen.getByText(/Table scan on users/)).toBeInTheDocument();
    });

    it("highlights actual time in ANALYZE output", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([["-> Nested loop (actual time=0.500..2.100 rows=50 loops=1) cost=1.50"]]),
          explainAnalyze: true,
        })
      );
      render(<ExplainPanel />);
      const timeSpan = screen.getByText(/actual time=0.500..2.100/);
      expect(timeSpan.className).toContain("text-yellow");
    });
  });

  describe("Extra highlight", () => {
    it("highlights Using filesort in Extra column", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([[...baseExplainRow]], ["Using filesort"]),
          explainAnalyze: false,
        })
      );
      render(<ExplainPanel />);
      const filesort = screen.getByText("Using filesort");
      expect(filesort.className).toContain("text-orange");
    });

    it("highlights Using temporary in Extra column", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([[...baseExplainRow]], ["Using temporary"]),
          explainAnalyze: false,
        })
      );
      render(<ExplainPanel />);
      const temp = screen.getByText("Using temporary");
      expect(temp.className).toContain("text-red");
    });

    it("highlights Using index in Extra column", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([[...baseExplainRow]], ["Using index"]),
          explainAnalyze: false,
        })
      );
      render(<ExplainPanel />);
      const idx = screen.getByText("Using index");
      expect(idx.className).toContain("text-green");
    });

    it("highlights Using where in Extra column", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([[...baseExplainRow]], ["Using where"]),
          explainAnalyze: false,
        })
      );
      render(<ExplainPanel />);
      const where = screen.getByText("Using where");
      expect(where.className).toContain("text-blue");
    });

    it("shows em dash for empty Extra", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([[...baseExplainRow]], [""]),
          explainAnalyze: false,
        })
      );
      render(<ExplainPanel />);
      // Empty Extra renders an em dash
      expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    });
  });

  describe("KeyHighlight", () => {
    it("highlights used key in possible_keys column", () => {
      const row = [1, "SIMPLE", "users", null, "ref", "PRIMARY,idx_email", "PRIMARY", "4", "const", 1, 100.0];
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([row]),
          explainAnalyze: false,
        })
      );
      render(<ExplainPanel />);
      // PRIMARY appears in both possible_keys and key columns - find the green-highlighted one
      const primaryElements = screen.getAllByText("PRIMARY");
      const highlighted = primaryElements.find((el) =>
        el.className.includes("text-green") || el.className.includes("font-medium")
      );
      expect(highlighted).toBeTruthy();
    });

    it("shows used key in green in key column", () => {
      const row = [1, "SIMPLE", "users", null, "ref", "idx_email", "idx_email", "767", "const", 1, 100.0];
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([row]),
          explainAnalyze: false,
        })
      );
      render(<ExplainPanel />);
      // The key column should have idx_email in green
      const allGreen = screen.getAllByText("idx_email");
      expect(allGreen.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("RowsBar", () => {
    it("shows formatted row count", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([[...baseExplainRow]]),
          explainAnalyze: false,
        })
      );
      render(<ExplainPanel />);
      expect(screen.getByText("1,000")).toBeInTheDocument();
    });
  });

  describe("ANALYZE output shape", () => {
    // MySQL answers EXPLAIN ANALYZE with one column of TREE text; MariaDB
    // answers ANALYZE with the same columns as EXPLAIN. Joining the latter with
    // newlines produced a wall of one word per line (#422).
    function makeTreeTextResult(text: string): QueryResult {
      return {
        query_id: "analyze-1",
        statement_index: 0,
        columns: [{ name: "EXPLAIN", data_type: "text", nullable: true, is_primary_key: false }],
        rows: [[text]],
        rows_affected: 0,
        execution_time_ms: 5,
        warnings: [],
        rows_truncated: false,
      } as QueryResult;
    }

    it("renders MySQL TREE text in the raw-text view", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeTreeTextResult("-> Table scan on users  (actual time=0.1..0.2 rows=5 loops=1)"),
          explainAnalyze: true,
          explainTabular: false,
        })
      );
      render(<ExplainPanel />);
      expect(screen.getByText(/Table scan on users/)).toBeInTheDocument();
      // No table header, because this is text output.
      expect(screen.queryByText("select_type")).not.toBeInTheDocument();
    });

    it("renders MariaDB tabular ANALYZE in the table view", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([[...baseExplainRow]]),
          explainAnalyze: true,
          explainTabular: true,
        })
      );
      render(<ExplainPanel />);
      expect(screen.getByText("select_type")).toBeInTheDocument();
      expect(screen.getByText("ANALYZE")).toBeInTheDocument();
    });
  });

  describe("downgrade notice", () => {
    it("explains why a plan was shown instead of timings", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([[...baseExplainRow]]),
          explainAnalyze: false,
          explainNotice: "EXPLAIN ANALYZE executes the statement, which would apply this write",
        })
      );
      render(<ExplainPanel />);
      expect(screen.getByText(/would apply this write/)).toBeInTheDocument();
    });

    it("shows nothing when there is no notice", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([[...baseExplainRow]]),
          explainAnalyze: false,
          explainNotice: null,
        })
      );
      render(<ExplainPanel />);
      expect(screen.queryByText(/would apply/)).not.toBeInTheDocument();
    });
  });

  describe("access type legend", () => {
    it("colours an index_merge badge instead of leaving it grey", () => {
      const row = [1, "SIMPLE", "users", null, "index_merge", null, "idx_a,idx_b", null, null, 10, 100.0];
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({ explainResult: makeExplainResult([row]), explainAnalyze: false })
      );
      render(<ExplainPanel />);
      const badges = screen.getAllByText("index_merge");
      expect(badges.some((b) => !b.className.includes("bg-gray-600"))).toBe(true);
    });

    it("lists the less common access types in the legend", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({ explainResult: makeExplainResult([[...baseExplainRow]]), explainAnalyze: false })
      );
      render(<ExplainPanel />);
      for (const type of ["index_merge", "fulltext", "spatial", "ref_or_null"]) {
        expect(screen.getByText(type)).toBeInTheDocument();
      }
    });
  });

  describe("cancel affordance", () => {
    it("offers Cancel on the plan panel while a statement is running", () => {
      const cancel = vi.fn();
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([[...baseExplainRow]]),
          explainAnalyze: false,
          isExecuting: true,
          cancelActiveQuery: cancel,
        })
      );
      render(<ExplainPanel />);
      fireEvent.click(screen.getByText("Cancel"));
      expect(cancel).toHaveBeenCalled();
    });

    it("offers Cancel on the ANALYZE panel too", () => {
      const cancel = vi.fn();
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: {
            query_id: "a",
            statement_index: 0,
            columns: [{ name: "EXPLAIN", data_type: "text", nullable: true, is_primary_key: false }],
            rows: [["-> Table scan"]],
            rows_affected: 0,
            execution_time_ms: 1,
            warnings: [],
            rows_truncated: false,
          } as QueryResult,
          explainAnalyze: true,
          explainTabular: false,
          isExecuting: true,
          cancelActiveQuery: cancel,
        })
      );
      render(<ExplainPanel />);
      fireEvent.click(screen.getByText("Cancel"));
      expect(cancel).toHaveBeenCalled();
    });

    it("hides Cancel when nothing is running", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([[...baseExplainRow]]),
          explainAnalyze: false,
          isExecuting: false,
        })
      );
      render(<ExplainPanel />);
      expect(screen.queryByText("Cancel")).not.toBeInTheDocument();
    });
  });
});

describe("plan formats (#424)", () => {
  const setExplainFormat = vi.fn();

  /** A one-cell result, which is what FORMAT=JSON and FORMAT=TREE return. */
  function singleCell(text: string): QueryResult {
    return {
      query_id: "explain-1",
      statement_index: 0,
      columns: [{ name: "EXPLAIN", data_type: "varchar", nullable: true, is_primary_key: false }],
      rows: [[text]],
      rows_affected: 0,
      execution_time_ms: 1,
      truncated: false,
      truncation_reason: null,
      sql: "",
    } as unknown as QueryResult;
  }

  function show(state: Record<string, unknown>) {
    useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
      s({
        explainAnalyze: false,
        explainTabular: false,
        explainNotice: null,
        explainFormat: "classic",
        explainRequestedFormat: "classic",
        isExecuting: false,
        setExplainFormat,
        ...state,
      })
    );
    render(<ExplainPanel />);
  }

  const jsonPlan = JSON.stringify({
    query_block: {
      select_id: 1,
      cost_info: { query_cost: "3.45" },
      table: {
        table_name: "orders",
        access_type: "ref",
        rows_examined_per_scan: 120,
        key: "idx_customer",
      },
    },
  });

  it("offers the three formats, on the tabular plan too", () => {
    show({ explainResult: makeExplainResult([[...baseExplainRow]]) });
    const picker = screen.getByLabelText("Plan format");
    expect(picker).toHaveValue("classic");
    expect(screen.getByRole("option", { name: /JSON/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Iterator tree/ })).toBeInTheDocument();
  });

  it("re-plans when another format is chosen", () => {
    show({ explainResult: makeExplainResult([[...baseExplainRow]]) });
    fireEvent.change(screen.getByLabelText("Plan format"), { target: { value: "json" } });
    expect(setExplainFormat).toHaveBeenCalledWith("json");
  });

  it("shows the cost model as a tree, not a wall of text", () => {
    show({ explainResult: singleCell(jsonPlan), explainFormat: "json", explainRequestedFormat: "json" });

    expect(screen.getByText("EXPLAIN FORMAT=JSON")).toBeInTheDocument();
    // The numbers the tabular plan rounds off, which is the reason to ask for
    // this format at all.
    expect(screen.getByText("3.45")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByText("orders")).toBeInTheDocument();
  });

  it("collapses a section of the plan when its header is clicked", () => {
    show({ explainResult: singleCell(jsonPlan), explainFormat: "json", explainRequestedFormat: "json" });

    const header = screen.getByRole("button", { name: /query_block/ });
    expect(header).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("orders")).toBeNull();
  });

  it("shows the text when the server sends something that is not JSON", () => {
    // Better than an empty panel: whatever came back is still readable.
    show({
      explainResult: singleCell("not json at all"),
      explainFormat: "json",
      explainRequestedFormat: "json",
    });
    expect(screen.getByText("not json at all")).toBeInTheDocument();
  });

  it("renders an iterator tree as text", () => {
    show({
      explainResult: singleCell("-> Table scan on orders  (cost=1.2 rows=100)"),
      explainFormat: "tree",
      explainRequestedFormat: "tree",
    });
    expect(screen.getByText("EXPLAIN FORMAT=TREE")).toBeInTheDocument();
    expect(screen.getByText(/Table scan on orders/)).toBeInTheDocument();
  });

  it("says why a format was not served", () => {
    // MariaDB has no tree format; the panel shows the tabular plan and says so
    // rather than an error where a plan should be.
    show({
      explainResult: makeExplainResult([[...baseExplainRow]]),
      explainRequestedFormat: "tree",
      explainNotice: "MariaDB has no tree format — showing the tabular plan instead.",
    });
    expect(screen.getByText(/MariaDB has no tree format/)).toBeInTheDocument();
  });

  it("cannot be changed while a plan is running", () => {
    show({ explainResult: makeExplainResult([[...baseExplainRow]]), isExecuting: true });
    expect(screen.getByLabelText("Plan format")).toBeDisabled();
  });
});
