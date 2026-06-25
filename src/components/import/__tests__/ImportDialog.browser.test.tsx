import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock API ──
vi.mock("../../../lib/tauri-api", () => ({
  api: {
    pickFile: vi.fn(),
    readFileContents: vi.fn(),
    executeQuery: vi.fn(),
    getTables: vi.fn(),
    getColumns: vi.fn(),
  },
}));

// ── Mock CSV parser and SQL import utils ──
vi.mock("../../../lib/csv-parser", () => ({
  parseCSV: vi.fn(),
}));

vi.mock("../../../lib/sql-import", () => ({
  splitSqlStatements: vi.fn(),
  generateBatchInsert: vi.fn().mockReturnValue(["INSERT INTO t VALUES (1)"]),
}));

import { parseCSV } from "../../../lib/csv-parser";
import { splitSqlStatements } from "../../../lib/sql-import";
import { api } from "../../../lib/tauri-api";
import { ImportDialog } from "../ImportDialog";

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  connectionId: "conn-1",
  database: "testdb",
};

describe("ImportDialog (browser)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Open/close states ───
  it("renders nothing when isOpen=false", () => {
    const { container } = render(
      <ImportDialog {...defaultProps} isOpen={false} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders modal when isOpen=true", () => {
    render(<ImportDialog {...defaultProps} />);
    expect(screen.getByText("Import Data")).toBeInTheDocument();
  });

  // ─── Mode tabs ───
  it("SQL mode tab is selected by default", () => {
    render(<ImportDialog {...defaultProps} />);
    const sqlTab = screen.getByText("SQL File");
    expect(sqlTab.className).toContain("brand");
  });

  it("switches to CSV mode tab", async () => {
    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("CSV File"));
    const csvTab = screen.getByText("CSV File");
    expect(csvTab.className).toContain("brand");
    // SQL tab should lose brand styling
    const sqlTab = screen.getByText("SQL File");
    expect(sqlTab.className).not.toContain("brand");
  });

  it("switches back to SQL mode tab", async () => {
    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("CSV File"));
    await user.click(screen.getByText("SQL File"));
    expect(screen.getByText("SQL File").className).toContain("brand");
  });

  // ─── Close behavior ───
  it("calls onClose when backdrop is clicked", async () => {
    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    const overlay = document.querySelector(".fixed.inset-0") as HTMLElement;
    await user.click(overlay);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when X close button is clicked", async () => {
    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    // X button is in the header
    const buttons = screen.getAllByRole("button");
    const xBtn = buttons.find((b) => b.querySelector(".lucide-x, svg"));
    if (xBtn) await user.click(xBtn);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("calls onClose when Cancel button is clicked", async () => {
    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("Cancel"));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("does not close when dialog content is clicked (stopPropagation)", async () => {
    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    const dialogBox = document.querySelector(".max-h-\\[85vh\\]") as HTMLElement;
    await user.click(dialogBox);
    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });

  // ─── File picker button ───
  it("shows 'Select file...' button", () => {
    render(<ImportDialog {...defaultProps} />);
    expect(screen.getByText("Select file...")).toBeInTheDocument();
  });

  it("file picker shows file name after selection", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/home/user/data.sql");
    vi.mocked(api.readFileContents).mockResolvedValue("SELECT 1;");
    vi.mocked(splitSqlStatements).mockReturnValue(["SELECT 1"]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("Select file..."));
    await waitFor(() => {
      expect(screen.getByText("data.sql")).toBeInTheDocument();
    });
  });

  // ─── SQL mode: content preview ───
  it("shows SQL file preview content", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/dump.sql");
    vi.mocked(api.readFileContents).mockResolvedValue(
      "CREATE TABLE t (id INT);\nINSERT INTO t VALUES (1);\nINSERT INTO t VALUES (2);",
    );
    vi.mocked(splitSqlStatements).mockReturnValue([
      "CREATE TABLE t (id INT)",
      "INSERT INTO t VALUES (1)",
      "INSERT INTO t VALUES (2)",
    ]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("Select file..."));
    await waitFor(() => {
      expect(screen.getByText(/CREATE TABLE/)).toBeInTheDocument();
    });
  });

  // ─── Multi-statement SQL detection ───
  it("shows statement count for multi-statement SQL", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/dump.sql");
    vi.mocked(api.readFileContents).mockResolvedValue("stmt1;\nstmt2;\nstmt3;");
    vi.mocked(splitSqlStatements).mockReturnValue(["stmt1", "stmt2", "stmt3"]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("Select file..."));
    await waitFor(() => {
      expect(screen.getByText("3 statements detected")).toBeInTheDocument();
    });
  });

  it("shows singular 'statement' for single statement", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/one.sql");
    vi.mocked(api.readFileContents).mockResolvedValue("SELECT 1;");
    vi.mocked(splitSqlStatements).mockReturnValue(["SELECT 1"]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("Select file..."));
    await waitFor(() => {
      expect(screen.getByText("1 statement detected")).toBeInTheDocument();
    });
  });

  // ─── Execute button states ───
  it("Execute SQL button is disabled when no file selected", () => {
    render(<ImportDialog {...defaultProps} />);
    const btn = screen.getByText("Execute SQL").closest("button");
    expect(btn?.disabled).toBe(true);
  });

  it("Execute SQL button is enabled after file is picked", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/dump.sql");
    vi.mocked(api.readFileContents).mockResolvedValue("SELECT 1;");
    vi.mocked(splitSqlStatements).mockReturnValue(["SELECT 1"]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("Select file..."));
    await waitFor(() => {
      const btn = screen.getByText("Execute SQL").closest("button");
      expect(btn?.disabled).toBe(false);
    });
  });

  // ─── SQL import execution ───
  it("executes SQL statements and shows progress", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/dump.sql");
    vi.mocked(api.readFileContents).mockResolvedValue("stmt1;\nstmt2;");
    vi.mocked(splitSqlStatements).mockReturnValue(["stmt1", "stmt2"]);
    vi.mocked(api.executeQuery).mockResolvedValue([]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("Select file..."));
    await waitFor(() => screen.getByText("Execute SQL"));
    await user.click(screen.getByText("Execute SQL"));

    await waitFor(() => {
      expect(api.executeQuery).toHaveBeenCalledTimes(2);
    });
  });

  it("shows success count after SQL import", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/dump.sql");
    vi.mocked(api.readFileContents).mockResolvedValue("stmt1;\nstmt2;");
    vi.mocked(splitSqlStatements).mockReturnValue(["stmt1", "stmt2"]);
    vi.mocked(api.executeQuery).mockResolvedValue([]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("Select file..."));
    await waitFor(() => screen.getByText("Execute SQL"));
    await user.click(screen.getByText("Execute SQL"));

    await waitFor(() => {
      expect(screen.getByText("2 succeeded")).toBeInTheDocument();
    });
  });

  it("shows error count and error list on SQL import failure", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/bad.sql");
    vi.mocked(api.readFileContents).mockResolvedValue("BAD;\nALSO BAD;");
    vi.mocked(splitSqlStatements).mockReturnValue(["BAD", "ALSO BAD"]);
    vi.mocked(api.executeQuery)
      .mockRejectedValueOnce("Syntax error")
      .mockRejectedValueOnce("Unknown table");

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("Select file..."));
    await waitFor(() => screen.getByText("Execute SQL"));
    await user.click(screen.getByText("Execute SQL"));

    await waitFor(() => {
      expect(screen.getByText("2 failed")).toBeInTheDocument();
      expect(screen.getByText(/Syntax error/)).toBeInTheDocument();
      expect(screen.getByText(/Unknown table/)).toBeInTheDocument();
    });
  });

  it("shows 'Import complete' after SQL execution finishes", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/dump.sql");
    vi.mocked(api.readFileContents).mockResolvedValue("stmt1;");
    vi.mocked(splitSqlStatements).mockReturnValue(["stmt1"]);
    vi.mocked(api.executeQuery).mockResolvedValue([]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("Select file..."));
    await waitFor(() => screen.getByText("Execute SQL"));
    await user.click(screen.getByText("Execute SQL"));

    await waitFor(() => {
      expect(screen.getByText("Import complete")).toBeInTheDocument();
    });
  });

  // ─── CSV mode: options ───
  it("shows CSV delimiter, quote, and header options after file pick", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/data.csv");
    vi.mocked(api.readFileContents).mockResolvedValue("name,age\nAlice,30");
    vi.mocked(parseCSV).mockReturnValue({
      headers: ["name", "age"],
      rows: [["Alice", "30"]],
    });
    vi.mocked(api.getTables).mockResolvedValue([]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("CSV File"));
    await user.click(screen.getByText("Select file..."));

    await waitFor(() => {
      expect(screen.getByText("Delimiter:")).toBeInTheDocument();
      expect(screen.getByText("Quote:")).toBeInTheDocument();
      expect(screen.getByText("Has header row")).toBeInTheDocument();
    });
  });

  it("changes CSV delimiter", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/data.csv");
    vi.mocked(api.readFileContents).mockResolvedValue("name|age\nAlice|30");
    vi.mocked(parseCSV).mockReturnValue({
      headers: ["name", "age"],
      rows: [["Alice", "30"]],
    });
    vi.mocked(api.getTables).mockResolvedValue([]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("CSV File"));
    await user.click(screen.getByText("Select file..."));

    await waitFor(() => screen.getByText("Delimiter:"));
    const delimiterSelect = screen.getByText("Delimiter:").parentElement?.querySelector("select") as HTMLSelectElement;
    fireEvent.change(delimiterSelect, { target: { value: "|" } });
    // Re-parse should happen via handleCsvOptionChange
    expect(parseCSV).toHaveBeenCalledTimes(2); // initial + after change
  });

  it("toggles has-header checkbox", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/data.csv");
    vi.mocked(api.readFileContents).mockResolvedValue("name,age\nAlice,30");
    vi.mocked(parseCSV).mockReturnValue({
      headers: ["name", "age"],
      rows: [["Alice", "30"]],
    });
    vi.mocked(api.getTables).mockResolvedValue([]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("CSV File"));
    await user.click(screen.getByText("Select file..."));

    await waitFor(() => screen.getByText("Has header row"));
    const checkbox = screen.getByText("Has header row").parentElement?.querySelector(
      "input[type='checkbox']",
    ) as HTMLInputElement;
    expect(checkbox?.checked).toBe(true);
    await user.click(checkbox!);
    expect(checkbox?.checked).toBe(false);
  });

  // ─── CSV preview table ───
  it("shows CSV row preview table with headers", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/data.csv");
    vi.mocked(api.readFileContents).mockResolvedValue("name,age,city\nAlice,30,NYC\nBob,25,LA");
    vi.mocked(parseCSV).mockReturnValue({
      headers: ["name", "age", "city"],
      rows: [
        ["Alice", "30", "NYC"],
        ["Bob", "25", "LA"],
      ],
    });
    vi.mocked(api.getTables).mockResolvedValue([]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("CSV File"));
    await user.click(screen.getByText("Select file..."));

    await waitFor(() => {
      expect(screen.getByText("name")).toBeInTheDocument();
      expect(screen.getByText("age")).toBeInTheDocument();
      expect(screen.getByText("Alice")).toBeInTheDocument();
      expect(screen.getByText("Bob")).toBeInTheDocument();
    });
  });

  it("shows row count note when more than 10 rows", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => [`Row${i}`, `${i}`]);
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/big.csv");
    vi.mocked(api.readFileContents).mockResolvedValue("col1,col2\n" + rows.map((r) => r.join(",")).join("\n"));
    vi.mocked(parseCSV).mockReturnValue({
      headers: ["col1", "col2"],
      rows,
    });
    vi.mocked(api.getTables).mockResolvedValue([]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("CSV File"));
    await user.click(screen.getByText("Select file..."));

    await waitFor(() => {
      expect(screen.getByText(/Showing 10 of 20 rows/)).toBeInTheDocument();
    });
  });

  // ─── Target table selector ───
  it("loads tables into target table selector", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/data.csv");
    vi.mocked(api.readFileContents).mockResolvedValue("name,age\nAlice,30");
    vi.mocked(parseCSV).mockReturnValue({
      headers: ["name", "age"],
      rows: [["Alice", "30"]],
    });
    vi.mocked(api.getTables).mockResolvedValue([
      { name: "people", table_type: "BASE TABLE", row_count: 50 },
      { name: "backup_people", table_type: "BASE TABLE", row_count: 50 },
    ]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("CSV File"));
    await user.click(screen.getByText("Select file..."));

    await waitFor(() => {
      expect(screen.getByText("Target table:")).toBeInTheDocument();
      expect(screen.getByText("people")).toBeInTheDocument();
      expect(screen.getByText("backup_people")).toBeInTheDocument();
    });
  });

  // ─── Column mapping ───
  it("shows column mapping UI when target table is selected", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/data.csv");
    vi.mocked(api.readFileContents).mockResolvedValue("name,age\nAlice,30");
    vi.mocked(parseCSV).mockReturnValue({
      headers: ["name", "age"],
      rows: [["Alice", "30"]],
    });
    vi.mocked(api.getTables).mockResolvedValue([
      { name: "people", table_type: "BASE TABLE", row_count: 50 },
    ]);
    vi.mocked(api.getColumns).mockResolvedValue([
      {
        name: "full_name",
        data_type: "varchar(100)",
        column_type: "varchar(100)",
        nullable: true,
        is_primary_key: false,
      },
      { name: "AGE", data_type: "int", column_type: "int", nullable: true, is_primary_key: false },
    ]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("CSV File"));
    await user.click(screen.getByText("Select file..."));

    await waitFor(() => screen.getByText("Target table:"));
    const targetSelect = screen.getByText("Target table:").parentElement?.querySelector("select") as HTMLSelectElement;
    fireEvent.change(targetSelect, { target: { value: "people" } });

    await waitFor(() => {
      expect(screen.getByText("Column Mapping")).toBeInTheDocument();
      expect(api.getColumns).toHaveBeenCalledWith("conn-1", "testdb", "people");
    });
  });

  it("auto-maps columns by case-insensitive name match", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/data.csv");
    vi.mocked(api.readFileContents).mockResolvedValue("name,age\nAlice,30");
    vi.mocked(parseCSV).mockReturnValue({
      headers: ["name", "age"],
      rows: [["Alice", "30"]],
    });
    vi.mocked(api.getTables).mockResolvedValue([
      { name: "people", table_type: "BASE TABLE", row_count: 50 },
    ]);
    // DB has "full_name" (won't match "name"), "AGE" (will match "age" case-insensitive)
    vi.mocked(api.getColumns).mockResolvedValue([
      { name: "full_name", data_type: "varchar", column_type: "varchar(100)", nullable: true, is_primary_key: false },
      { name: "AGE", data_type: "int", column_type: "int", nullable: true, is_primary_key: false },
    ]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("CSV File"));
    await user.click(screen.getByText("Select file..."));

    await waitFor(() => screen.getByText("Target table:"));
    const targetSelect = screen.getByText("Target table:").parentElement?.querySelector("select") as HTMLSelectElement;
    fireEvent.change(targetSelect, { target: { value: "people" } });

    await waitFor(() => {
      expect(screen.getByText("Column Mapping")).toBeInTheDocument();
    });

    // "name" should not be auto-mapped (no matching column)
    // "age" should be auto-mapped to "AGE"
    const mappingSelects = screen.getAllByRole("combobox");
    // The selects include: delimiter, quote, target table, and column mapping selects
    // Find the column mapping select for "age" which should have "AGE" pre-selected
    const ageMappingSelect = mappingSelects.find(
      (s) => (s as HTMLSelectElement).value === "AGE",
    );
    expect(ageMappingSelect).toBeTruthy();
  });

  // ─── Import CSV button states ───
  it("Import CSV button is disabled when no target table", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/data.csv");
    vi.mocked(api.readFileContents).mockResolvedValue("name,age\nAlice,30");
    vi.mocked(parseCSV).mockReturnValue({
      headers: ["name", "age"],
      rows: [["Alice", "30"]],
    });
    vi.mocked(api.getTables).mockResolvedValue([]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("CSV File"));
    await user.click(screen.getByText("Select file..."));

    await waitFor(() => screen.getByText("Import CSV"));
    const btn = screen.getByText("Import CSV").closest("button");
    expect(btn?.disabled).toBe(true);
  });

  it("Import CSV button is disabled when no columns mapped", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/data.csv");
    vi.mocked(api.readFileContents).mockResolvedValue("name,age\nAlice,30");
    vi.mocked(parseCSV).mockReturnValue({
      headers: ["name", "age"],
      rows: [["Alice", "30"]],
    });
    vi.mocked(api.getTables).mockResolvedValue([
      { name: "people", table_type: "BASE TABLE", row_count: 50 },
    ]);
    vi.mocked(api.getColumns).mockResolvedValue([
      { name: "col_x", data_type: "text", column_type: "text", nullable: true, is_primary_key: false },
    ]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("CSV File"));
    await user.click(screen.getByText("Select file..."));

    await waitFor(() => screen.getByText("Target table:"));
    const targetSelect = screen.getByText("Target table:").parentElement?.querySelector("select") as HTMLSelectElement;
    fireEvent.change(targetSelect, { target: { value: "people" } });

    await waitFor(() => screen.getByText("Column Mapping"));
    const btn = screen.getByText("Import CSV").closest("button");
    expect(btn?.disabled).toBe(true);
  });

  // ─── CSV import execution ───
  it("executes CSV import and shows row progress", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/data.csv");
    vi.mocked(api.readFileContents).mockResolvedValue("name,age\nAlice,30\nBob,25");
    vi.mocked(parseCSV).mockReturnValue({
      headers: ["name", "age"],
      rows: [
        ["Alice", "30"],
        ["Bob", "25"],
      ],
    });
    vi.mocked(api.getTables).mockResolvedValue([
      { name: "people", table_type: "BASE TABLE", row_count: 50 },
    ]);
    vi.mocked(api.getColumns).mockResolvedValue([
      { name: "name", data_type: "text", column_type: "text", nullable: true, is_primary_key: false },
      { name: "age", data_type: "int", column_type: "int", nullable: true, is_primary_key: false },
    ]);
    vi.mocked(api.executeQuery).mockResolvedValue([]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("CSV File"));
    await user.click(screen.getByText("Select file..."));

    await waitFor(() => screen.getByText("Target table:"));
    const targetSelect = screen.getByText("Target table:").parentElement?.querySelector("select") as HTMLSelectElement;
    fireEvent.change(targetSelect, { target: { value: "people" } });

    await waitFor(() => screen.getByText("Column Mapping"));
    await user.click(screen.getByText("Import CSV"));

    await waitFor(() => {
      expect(api.executeQuery).toHaveBeenCalled();
    });
  });

  it("shows progress bar during import", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/data.csv");
    vi.mocked(api.readFileContents).mockResolvedValue("name,age\nAlice,30\nBob,25");
    vi.mocked(parseCSV).mockReturnValue({
      headers: ["name", "age"],
      rows: [
        ["Alice", "30"],
        ["Bob", "25"],
      ],
    });
    vi.mocked(api.getTables).mockResolvedValue([
      { name: "people", table_type: "BASE TABLE", row_count: 50 },
    ]);
    vi.mocked(api.getColumns).mockResolvedValue([
      { name: "name", data_type: "text", column_type: "text", nullable: true, is_primary_key: false },
      { name: "age", data_type: "int", column_type: "int", nullable: true, is_primary_key: false },
    ]);
    vi.mocked(api.executeQuery).mockResolvedValue([]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("CSV File"));
    await user.click(screen.getByText("Select file..."));

    await waitFor(() => screen.getByText("Target table:"));
    const targetSelect = screen.getByText("Target table:").parentElement?.querySelector("select") as HTMLSelectElement;
    fireEvent.change(targetSelect, { target: { value: "people" } });

    await waitFor(() => screen.getByText("Column Mapping"));
    await user.click(screen.getByText("Import CSV"));

    await waitFor(() => {
      // The progress bar div with rounded-full
      const progressBar = document.querySelector(".h-1\\.5.w-full.rounded-full");
      expect(progressBar).toBeTruthy();
    });
  });

  it("shows success count after CSV import completes", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/data.csv");
    vi.mocked(api.readFileContents).mockResolvedValue("name,age\nAlice,30\nBob,25");
    vi.mocked(parseCSV).mockReturnValue({
      headers: ["name", "age"],
      rows: [
        ["Alice", "30"],
        ["Bob", "25"],
      ],
    });
    vi.mocked(api.getTables).mockResolvedValue([
      { name: "people", table_type: "BASE TABLE", row_count: 50 },
    ]);
    vi.mocked(api.getColumns).mockResolvedValue([
      { name: "name", data_type: "text", column_type: "text", nullable: true, is_primary_key: false },
      { name: "age", data_type: "int", column_type: "int", nullable: true, is_primary_key: false },
    ]);
    vi.mocked(api.executeQuery).mockResolvedValue([]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("CSV File"));
    await user.click(screen.getByText("Select file..."));

    await waitFor(() => screen.getByText("Target table:"));
    const targetSelect = screen.getByText("Target table:").parentElement?.querySelector("select") as HTMLSelectElement;
    fireEvent.change(targetSelect, { target: { value: "people" } });

    await waitFor(() => screen.getByText("Column Mapping"));
    await user.click(screen.getByText("Import CSV"));

    await waitFor(() => {
      expect(screen.getByText("2 rows imported")).toBeInTheDocument();
    });
  });

  it("shows error count in CSV import on failure", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/data.csv");
    vi.mocked(api.readFileContents).mockResolvedValue("name,age\nAlice,30");
    vi.mocked(parseCSV).mockReturnValue({
      headers: ["name", "age"],
      rows: [["Alice", "30"]],
    });
    vi.mocked(api.getTables).mockResolvedValue([
      { name: "people", table_type: "BASE TABLE", row_count: 50 },
    ]);
    vi.mocked(api.getColumns).mockResolvedValue([
      { name: "name", data_type: "text", column_type: "text", nullable: true, is_primary_key: false },
      { name: "age", data_type: "int", column_type: "int", nullable: true, is_primary_key: false },
    ]);
    vi.mocked(api.executeQuery).mockRejectedValue("Duplicate entry");

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("CSV File"));
    await user.click(screen.getByText("Select file..."));

    await waitFor(() => screen.getByText("Target table:"));
    const targetSelect = screen.getByText("Target table:").parentElement?.querySelector("select") as HTMLSelectElement;
    fireEvent.change(targetSelect, { target: { value: "people" } });

    await waitFor(() => screen.getByText("Column Mapping"));
    await user.click(screen.getByText("Import CSV"));

    await waitFor(() => {
      expect(screen.getByText("1 failed")).toBeInTheDocument();
      expect(screen.getByText(/Duplicate entry/)).toBeInTheDocument();
    });
  });

  // ─── Import complete state ───
  it("shows Close button instead of Cancel after import completes", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/dump.sql");
    vi.mocked(api.readFileContents).mockResolvedValue("SELECT 1;");
    vi.mocked(splitSqlStatements).mockReturnValue(["SELECT 1"]);
    vi.mocked(api.executeQuery).mockResolvedValue([]);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("Select file..."));
    await waitFor(() => screen.getByText("Execute SQL"));
    await user.click(screen.getByText("Execute SQL"));

    await waitFor(() => {
      expect(screen.getByText("Close")).toBeInTheDocument();
    });
  });

  // ─── Disabled state during import ───
  it("disables file pick button during import", async () => {
    // Use a promise that never resolves to keep importing=true
    let resolveQuery: (v: unknown) => void;
    const queryPromise = new Promise((r) => {
      resolveQuery = r;
    });
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/dump.sql");
    vi.mocked(api.readFileContents).mockResolvedValue("SELECT 1;");
    vi.mocked(splitSqlStatements).mockReturnValue(["SELECT 1"]);
    vi.mocked(api.executeQuery).mockReturnValue(queryPromise as Promise<any>);

    const user = userEvent.setup();
    render(<ImportDialog {...defaultProps} />);
    await user.click(screen.getByText("Select file..."));
    await waitFor(() => screen.getByText("Execute SQL"));
    await user.click(screen.getByText("Execute SQL"));

    // During import, file pick button and X button should be disabled
    const fileBtn = screen.getByText("dump.sql").closest("button");
    expect(fileBtn?.disabled).toBe(true);

    // Resolve to clean up
    resolveQuery!(null);
  });
});
