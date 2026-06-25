import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportDialog } from "../ImportDialog";

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    pickFile: vi.fn(),
    readFileContents: vi.fn(),
    executeQuery: vi.fn(),
    getTables: vi.fn(),
    getColumns: vi.fn(),
  },
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

describe("ImportDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    it("picks SQL file and shows preview", async () => {
      vi.mocked(api.pickFile).mockResolvedValue("/path/to/file.sql");
      vi.mocked(api.readFileContents).mockResolvedValue(
        "CREATE TABLE t1 (id INT);\nINSERT INTO t1 VALUES (1);",
      );
      vi.mocked(splitSqlStatements).mockReturnValue([
        "CREATE TABLE t1 (id INT)",
        "INSERT INTO t1 VALUES (1)",
      ]);

      render(<ImportDialog {...mockProps} />);

      await act(async () => {
        fireEvent.click(screen.getByText("Select file..."));
      });

      expect(screen.getByText(/2 statements detected/)).toBeDefined();
      expect(screen.getByText("Execute SQL")).toBeDefined();
    });

    it("executes SQL statements on import", async () => {
      vi.mocked(api.pickFile).mockResolvedValue("/path/to/file.sql");
      vi.mocked(api.readFileContents).mockResolvedValue(
        "CREATE TABLE t1 (id INT);\nINSERT INTO t1 VALUES (1);",
      );
      vi.mocked(splitSqlStatements).mockReturnValue([
        "CREATE TABLE t1 (id INT)",
        "INSERT INTO t1 VALUES (1)",
      ]);
      vi.mocked(api.executeQuery).mockResolvedValue([]);

      render(<ImportDialog {...mockProps} />);

      await act(async () => {
        fireEvent.click(screen.getByText("Select file..."));
      });

      await act(async () => {
        fireEvent.click(screen.getByText("Execute SQL"));
      });

      expect(api.executeQuery).toHaveBeenCalled();
    });

    it("handles import errors gracefully", async () => {
      vi.mocked(api.pickFile).mockResolvedValue("/path/to/file.sql");
      vi.mocked(api.readFileContents).mockResolvedValue("BAD SQL");
      vi.mocked(splitSqlStatements).mockReturnValue(["BAD SQL"]);
      vi.mocked(api.executeQuery).mockRejectedValue("Syntax error");

      render(<ImportDialog {...mockProps} />);

      await act(async () => {
        fireEvent.click(screen.getByText("Select file..."));
      });

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
      vi.mocked(api.readFileContents).mockResolvedValue("BAD");
      vi.mocked(splitSqlStatements).mockReturnValue(["BAD"]);
      vi.mocked(api.executeQuery).mockRejectedValue("Failed");

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
