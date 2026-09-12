import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportDialog } from "../ImportDialog";

const { listenFn } = vi.hoisted(() => ({ listenFn: vi.fn() }));

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    pickFile: vi.fn(),
    readFileContents: vi.fn(),
    readFileHead: vi.fn(),
    restoreDatabase: vi.fn(),
    executeQuery: vi.fn(),
    getTables: vi.fn(),
    getColumns: vi.fn(),
  },
}));

vi.mock("../../../lib/bindings", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  events: { restoreProgressEvent: { listen: listenFn } },
}));

vi.mock("../../../lib/csv-parser", () => ({
  parseCSV: vi.fn(),
}));

vi.mock("../../../lib/sql-import", () => ({
  splitSqlStatements: vi.fn(),
  generateBatchInsert: vi.fn().mockReturnValue(["INSERT INTO ..."]),
}));

import { parseCSV } from "../../../lib/csv-parser";
import { splitSqlStatements } from "../../../lib/sql-import";
import { api } from "../../../lib/tauri-api";

const mockProps = {
  isOpen: true,
  onClose: vi.fn(),
  connectionId: "conn-1",
  database: "testdb",
};

/** What the backend reports for a clean run. */
const cleanSummary = {
  statementsRun: 2,
  statementsFailed: 0,
  bytesRead: 100,
  elapsedMs: 10,
  cancelled: false,
  rolledBack: false,
  partiallyApplied: false,
  errors: [] as string[],
};

describe("ImportDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenFn.mockResolvedValue(() => {});
    vi.mocked(api.readFileHead).mockResolvedValue({
      text: "-- dump",
      totalBytes: 100,
      truncated: false,
    });
    vi.mocked(api.restoreDatabase).mockResolvedValue({ ...cleanSummary });
  });

  it("renders null when not open", () => {
    const { container } = render(
      <ImportDialog {...mockProps} isOpen={false} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders dialog with 'Import Data' title", () => {
    render(<ImportDialog {...mockProps} />);
    expect(screen.getByText("Import Data")).toBeDefined();
  });

  it("shows SQL and CSV mode tabs", () => {
    render(<ImportDialog {...mockProps} />);
    expect(screen.getByText("SQL File")).toBeDefined();
    expect(screen.getByText("CSV File")).toBeDefined();
  });

  it("defaults to SQL mode", () => {
    render(<ImportDialog {...mockProps} />);
    expect(screen.getByText("SQL File").className).toContain("brand");
  });

  it("switches to CSV mode", () => {
    render(<ImportDialog {...mockProps} />);
    fireEvent.click(screen.getByText("CSV File"));
    expect(screen.getByText("CSV File").className).toContain("brand");
  });

  it("calls onClose when overlay is clicked", () => {
    render(<ImportDialog {...mockProps} />);
    const overlay = document.querySelector(".fixed.inset-0") as HTMLElement;
    if (overlay) fireEvent.click(overlay);
    expect(mockProps.onClose).toHaveBeenCalled();
  });

  it("calls close when Cancel button is clicked", () => {
    render(<ImportDialog {...mockProps} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(mockProps.onClose).toHaveBeenCalled();
  });

  it("shows 'Select file...' button", () => {
    render(<ImportDialog {...mockProps} />);
    expect(screen.getByText("Select file...")).toBeDefined();
  });

  describe("SQL mode", () => {
    /** Choose a file whose scanned head splits into `statements`. */
    async function pickFile(statements: string[], truncated = false) {
      vi.mocked(api.pickFile).mockResolvedValue("/path/to/file.sql");
      vi.mocked(api.readFileHead).mockResolvedValue({
        text: statements.join(";\n"),
        totalBytes: 4096,
        truncated,
      });
      vi.mocked(splitSqlStatements).mockReturnValue(statements);

      render(<ImportDialog {...mockProps} />);
      await act(async () => {
        fireEvent.click(screen.getByText("Select file..."));
      });
    }

    it("reads only the head of the file for the preview", async () => {
      // A dump is run by the backend straight from disk, so the renderer
      // never needs to hold one (#366).
      await pickFile(["CREATE TABLE t1 (id INT)", "INSERT INTO t1 VALUES (1)"]);

      expect(api.readFileHead).toHaveBeenCalledWith("/path/to/file.sql", 512 * 1024);
      expect(api.readFileContents).not.toHaveBeenCalled();
      expect(screen.getByText(/2 statements detected/)).toBeDefined();
    });

    it("says when the preview did not reach the end of the file", async () => {
      // Otherwise "3 statements detected" for a 2 GB dump is a lie.
      await pickFile(["INSERT INTO t VALUES (1)"], true);
      expect(screen.getByText(/the whole file is imported/)).toBeDefined();
    });

    it("hands the file to the backend rather than running it statement by statement", async () => {
      await pickFile(["INSERT INTO t VALUES (1)"]);
      await act(async () => {
        fireEvent.click(screen.getByText("Execute SQL"));
      });

      expect(api.restoreDatabase).toHaveBeenCalledWith(
        expect.any(String),
        "conn-1",
        "testdb",
        "/path/to/file.sql",
        expect.objectContaining({ stopOnError: true }),
      );
      expect(api.executeQuery).not.toHaveBeenCalled();
    });

    it("passes on the user's choice to keep going past errors", async () => {
      await pickFile(["INSERT INTO t VALUES (1)"]);
      fireEvent.click(screen.getByLabelText("Stop at the first error"));
      await act(async () => {
        fireEvent.click(screen.getByText("Execute SQL"));
      });

      expect(api.restoreDatabase).toHaveBeenCalledWith(
        expect.any(String),
        "conn-1",
        "testdb",
        "/path/to/file.sql",
        expect.objectContaining({ stopOnError: false }),
      );
    });

    it("says where it stopped and whether anything stands", async () => {
      vi.mocked(api.restoreDatabase).mockResolvedValue({
        ...cleanSummary,
        statementsRun: 1,
        statementsFailed: 1,
        partiallyApplied: true,
        errors: ["Statement 2: Table 'x' doesn't exist"],
      });
      await pickFile(["CREATE TABLE t (id INT)", "INSERT INTO x VALUES (1)"]);
      await act(async () => {
        fireEvent.click(screen.getByText("Execute SQL"));
      });

      const stopped = screen.getByTestId("stopped-at");
      expect(stopped.textContent).toContain("statement 2");
      expect(stopped.textContent).toContain("1 already ran");
      expect(stopped.textContent).toContain("MySQL commits before every CREATE");
      expect(screen.getByText(/Table 'x' doesn't exist/)).toBeDefined();
    });

    it("says the database is unchanged when nothing was committed", async () => {
      vi.mocked(api.restoreDatabase).mockResolvedValue({
        ...cleanSummary,
        statementsRun: 1,
        statementsFailed: 1,
        rolledBack: true,
        partiallyApplied: false,
        errors: ["Statement 2: Duplicate entry"],
      });
      await pickFile(["INSERT INTO t VALUES (1)", "INSERT INTO t VALUES (1)"]);
      await act(async () => {
        fireEvent.click(screen.getByText("Execute SQL"));
      });

      expect(screen.getByTestId("stopped-at").textContent)
        .toContain("the database is as it was");
    });

    it("does not claim the import can be rolled back", async () => {
      await pickFile(["INSERT INTO t VALUES (1)"]);
      expect(screen.getByText(/cannot be rolled back/)).toBeDefined();
    });

    it("says what a dump will drop, before it is run", async () => {
      // A DROP TABLE can sit at line 5,000 of a dump. Rendering the file
      // verbatim meant reading all of it to find out (#367).
      await pickFile([
        "INSERT INTO t1 VALUES (1)",
        "DROP TABLE users",
        "TRUNCATE TABLE audit_log",
      ]);

      const warning = screen.getByTestId("destructive-warning");
      expect(warning.textContent).toContain("2 statements");
      expect(warning.textContent).toContain("DROP TABLE users");
      expect(warning.textContent).toContain("TRUNCATE TABLE audit_log");
    });

    it("says nothing about a dump that only inserts", async () => {
      await pickFile(["INSERT INTO t1 VALUES (1)", "INSERT INTO t1 VALUES (2)"]);
      expect(screen.queryByTestId("destructive-warning")).toBeNull();
    });

    it("handles a run that could not start", async () => {
      vi.mocked(api.restoreDatabase).mockRejectedValue("Syntax error");
      await pickFile(["BAD SQL"]);
      await act(async () => {
        fireEvent.click(screen.getByText("Execute SQL"));
      });

      expect(await screen.findByText(/Syntax error/)).toBeDefined();
    });

    it("disable Execute SQL when no file selected", () => {
      render(<ImportDialog {...mockProps} />);
      const btn = screen.getByText("Execute SQL");
      expect(btn.closest("button")?.disabled).toBe(true);
    });
  });

  describe("CSV mode", () => {
    it("shows CSV options after file selection", async () => {
      vi.mocked(api.pickFile).mockResolvedValue("/path/to/data.csv");
      vi.mocked(api.readFileContents).mockResolvedValue("name,age\nAlice,30\nBob,25");
      vi.mocked(parseCSV).mockReturnValue({
        headers: ["name", "age"],
        rows: [
          ["Alice", "30"],
          ["Bob", "25"],
        ],
      });
      vi.mocked(api.getTables).mockResolvedValue([]);

      render(<ImportDialog {...mockProps} />);

      fireEvent.click(screen.getByText("CSV File"));

      await act(async () => {
        fireEvent.click(screen.getByText("Select file..."));
      });

      expect(await screen.findByText("Delimiter:")).toBeDefined();
      expect(screen.getByText("Target table:")).toBeDefined();
    });

    it("disables Import CSV when no target table selected", async () => {
      render(<ImportDialog {...mockProps} />);
      fireEvent.click(screen.getByText("CSV File"));

      vi.mocked(api.pickFile).mockResolvedValue("/path/to/data.csv");
      vi.mocked(api.readFileContents).mockResolvedValue("name,age\nAlice,30");
      vi.mocked(parseCSV).mockReturnValue({
        headers: ["name", "age"],
        rows: [["Alice", "30"]],
        bareEmpty: [["Alice", "30"]].map((r: unknown[]) => r.map(() => false)),
      });
      vi.mocked(api.getTables).mockResolvedValue([]);

      await act(async () => {
        fireEvent.click(screen.getByText("Select file..."));
      });

      const importBtn = screen.getByText("Import CSV");
      expect(importBtn.closest("button")?.disabled).toBe(true);
    });

    it("shows hash header checkbox option", async () => {
      vi.mocked(api.pickFile).mockResolvedValue("/path/to/data.csv");
      vi.mocked(api.readFileContents).mockResolvedValue("name,age\nAlice,30");
      vi.mocked(parseCSV).mockReturnValue({
        headers: ["name", "age"],
        rows: [["Alice", "30"]],
        bareEmpty: [["Alice", "30"]].map((r: unknown[]) => r.map(() => false)),
      });
      vi.mocked(api.getTables).mockResolvedValue([]);

      render(<ImportDialog {...mockProps} />);
      fireEvent.click(screen.getByText("CSV File"));

      await act(async () => {
        fireEvent.click(screen.getByText("Select file..."));
      });

      await waitFor(() => {
        expect(screen.getByText("Has header row")).toBeDefined();
      });
    });

    it("shows target table select with loaded tables", async () => {
      vi.mocked(api.pickFile).mockResolvedValue("/path/to/data.csv");
      vi.mocked(api.readFileContents).mockResolvedValue("name,age\nAlice,30");
      vi.mocked(parseCSV).mockReturnValue({
        headers: ["name", "age"],
        rows: [["Alice", "30"]],
        bareEmpty: [["Alice", "30"]].map((r: unknown[]) => r.map(() => false)),
      });
      vi.mocked(api.getTables).mockResolvedValue([
        { name: "people", table_type: "BASE TABLE", row_count: 0 },
      ]);

      render(<ImportDialog {...mockProps} />);
      fireEvent.click(screen.getByText("CSV File"));

      await act(async () => {
        fireEvent.click(screen.getByText("Select file..."));
      });

      await waitFor(() => {
        expect(screen.getByText("people")).toBeDefined();
      });
    });
  });

  describe("progress and errors", () => {
    it("shows error details in error list", async () => {
      vi.mocked(api.pickFile).mockResolvedValue("/path/to/file.sql");
      vi.mocked(api.readFileHead).mockResolvedValue({
        text: "BAD",
        totalBytes: 3,
        truncated: false,
      });
      vi.mocked(splitSqlStatements).mockReturnValue(["BAD"]);
      vi.mocked(api.restoreDatabase).mockResolvedValue({
        ...cleanSummary,
        statementsRun: 0,
        statementsFailed: 1,
        errors: ["Statement 1: Failed"],
      });

      render(<ImportDialog {...mockProps} />);

      await act(async () => {
        fireEvent.click(screen.getByText("Select file..."));
      });

      await act(async () => {
        fireEvent.click(screen.getByText("Execute SQL"));
      });

      await waitFor(() => {
        expect(screen.getByText(/Failed/)).toBeDefined();
      });
    });
  });
});
