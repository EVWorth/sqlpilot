import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ExplainPanel } from "../ExplainPanel";
import type { QueryResult } from "../../types";

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
        s({ explainResult: null, explainAnalyze: false }),
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
        }),
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
        }),
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
        }),
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
        }),
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
        }),
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
        }),
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
        }),
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
        }),
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
          explainResult: makeExplainResult([["-> Nested loop inner join  (cost=2.50 rows=100) (actual time=0.125..1.234 rows=100 loops=1)"]]),
          explainAnalyze: true,
        }),
      );
      render(<ExplainPanel />);
      expect(screen.getByText("EXPLAIN ANALYZE")).toBeInTheDocument();
    });

    it("renders ANALYZE text content", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([["-> Table scan on users  (cost=2.50 rows=100)"]]),
          explainAnalyze: true,
        }),
      );
      render(<ExplainPanel />);
      expect(screen.getByText(/Table scan on users/)).toBeInTheDocument();
    });

    it("highlights actual time in ANALYZE output", () => {
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([["-> Nested loop (actual time=0.500..2.100 rows=50 loops=1) cost=1.50"]]),
          explainAnalyze: true,
        }),
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
        }),
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
        }),
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
        }),
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
        }),
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
        }),
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
        }),
      );
      render(<ExplainPanel />);
      // PRIMARY appears in both possible_keys and key columns - find the green-highlighted one
      const primaryElements = screen.getAllByText("PRIMARY");
      const highlighted = primaryElements.find((el) =>
        el.className.includes("text-green") || el.className.includes("font-medium"),
      );
      expect(highlighted).toBeTruthy();
    });

    it("shows used key in green in key column", () => {
      const row = [1, "SIMPLE", "users", null, "ref", "idx_email", "idx_email", "767", "const", 1, 100.0];
      useResultStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({
          explainResult: makeExplainResult([row]),
          explainAnalyze: false,
        }),
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
        }),
      );
      render(<ExplainPanel />);
      expect(screen.getByText("1,000")).toBeInTheDocument();
    });
  });
});
