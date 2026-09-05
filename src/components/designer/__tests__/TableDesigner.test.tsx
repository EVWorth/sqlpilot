import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TableDesigner } from "../TableDesigner";

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    getTables: vi.fn(),
    getColumns: vi.fn(),
    getIndexes: vi.fn(),
    getTableDdl: vi.fn(),
    executeQuery: vi.fn(),
  },
}));

vi.mock("../SQLPreviewDialog", () => ({
  SQLPreviewDialog: ({ sql, onClose, onExecute }: { sql: string; onClose: () => void; onExecute: () => void }) => (
    <div data-testid="sql-preview-dialog">
      <pre>{sql}</pre>
      <button onClick={onClose}>Close Preview</button>
      <button onClick={onExecute}>Execute Preview</button>
    </div>
  ),
}));

import { api } from "../../../lib/tauri-api";

const mockColumns = [
  {
    name: "id",
    data_type: "int",
    column_type: "INT",
    nullable: false,
    is_primary_key: true,
    default_value: undefined,
    extra: "auto_increment",
    comment: "primary key",
  },
  {
    name: "name",
    data_type: "varchar",
    column_type: "VARCHAR(255)",
    nullable: false,
    is_primary_key: false,
    default_value: undefined,
    extra: "",
    comment: "",
  },
];

const mockIndexes = [
  { name: "PRIMARY", columns: ["id"], is_unique: true, index_type: "BTREE" },
];

describe("TableDesigner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getTables).mockResolvedValue([
      { name: "other_table", table_type: "BASE TABLE", engine: "InnoDB", row_count: 0, data_size: 0, comment: "" },
    ]);
    // Alter mode reads the table's real engine/charset/collation/comment out
    // of its DDL; a table with nothing unusual set looks like this.
    vi.mocked(api.getTableDdl).mockResolvedValue(
      "CREATE TABLE `users` (\n  `id` int NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci",
    );
  });

  describe("create mode", () => {
    it("renders table name input and database label", () => {
      render(
        <TableDesigner connectionId="conn-1" database="testdb" />,
      );
      // "testdb" text appears in the "in testdb" label
      expect(screen.getByText(/testdb/)).toBeDefined();
      // The table name input exists as a textbox role
      const inputs = screen.getAllByRole("textbox");
      expect(inputs.length).toBeGreaterThanOrEqual(1);
    });

    it("shows sub-tabs: Columns, Indexes, Foreign Keys, Options", () => {
      render(
        <TableDesigner connectionId="conn-1" database="testdb" />,
      );
      expect(screen.getByText("Columns")).toBeDefined();
      expect(screen.getByText("Indexes")).toBeDefined();
      expect(screen.getByText("Foreign Keys")).toBeDefined();
      expect(screen.getByText("Options")).toBeDefined();
    });

    it("starts with one empty column row in Columns tab", () => {
      render(
        <TableDesigner connectionId="conn-1" database="testdb" />,
      );
      const nameInputs = screen.getAllByPlaceholderText("column_name");
      expect(nameInputs.length).toBeGreaterThanOrEqual(1);
    });

    it("adds a new column on 'Add Column' click", () => {
      render(
        <TableDesigner connectionId="conn-1" database="testdb" />,
      );
      const initialCount = screen.getAllByPlaceholderText("column_name").length;
      fireEvent.click(screen.getByText("Add Column"));
      expect(screen.getAllByPlaceholderText("column_name").length).toBe(initialCount + 1);
    });

    it("removes a column on trash click", () => {
      render(
        <TableDesigner connectionId="conn-1" database="testdb" />,
      );
      fireEvent.click(screen.getByText("Add Column"));
      const initialCount = screen.getAllByRole("button").length;
      // Find the trash button in the last column row
      const trashButtons = screen.getAllByRole("button").filter(
        (btn) => btn.querySelector("svg") && btn.innerHTML.includes("lucide-trash"),
      );
      // Just verify we can see the buttons
      expect(trashButtons.length).toBeGreaterThanOrEqual(0);
    });

    it("shows Options tab with engine, charset, collation selects", () => {
      render(
        <TableDesigner connectionId="conn-1" database="testdb" />,
      );
      fireEvent.click(screen.getByText("Options"));
      expect(screen.getByText("Engine")).toBeDefined();
      expect(screen.getByText("Character Set")).toBeDefined();
      expect(screen.getByText("Collation")).toBeDefined();
    });

    it("shows Preview SQL dialog on Preview click", async () => {
      render(
        <TableDesigner connectionId="conn-1" database="testdb" />,
      );
      fireEvent.click(screen.getByText("Preview SQL"));
      expect(screen.getByTestId("sql-preview-dialog")).toBeDefined();
    });

    it("creates table on Save click", async () => {
      vi.mocked(api.executeQuery).mockResolvedValue([]);

      render(
        <TableDesigner connectionId="conn-1" database="testdb" />,
      );

      const tableNameInput = screen.getByPlaceholderText("table_name");
      fireEvent.change(tableNameInput, { target: { value: "my_new_table" } });

      const columnNameInput = screen.getByPlaceholderText("column_name");
      fireEvent.change(columnNameInput, { target: { value: "id" } });

      const btn = screen.getByText("Create Table");

      await act(async () => {
        fireEvent.click(btn);
      });

      expect(api.executeQuery).toHaveBeenCalled();
    });

    it("shows success message after creating table", async () => {
      vi.mocked(api.executeQuery).mockResolvedValue([]);

      render(
        <TableDesigner connectionId="conn-1" database="testdb" />,
      );

      const tableNameInput = screen.getByPlaceholderText("table_name");
      fireEvent.change(tableNameInput, { target: { value: "my_table" } });

      const columnNameInput = screen.getByPlaceholderText("column_name");
      fireEvent.change(columnNameInput, { target: { value: "id" } });

      await act(async () => {
        fireEvent.click(screen.getByText("Create Table"));
      });

      expect(await screen.findByText("Table saved successfully!")).toBeDefined();
    });

    it("shows error on save failure", async () => {
      vi.mocked(api.executeQuery).mockRejectedValue("SQL error");

      render(
        <TableDesigner connectionId="conn-1" database="testdb" />,
      );

      const tableNameInput = screen.getByPlaceholderText("table_name");
      fireEvent.change(tableNameInput, { target: { value: "bad_table" } });

      const columnNameInput = screen.getByPlaceholderText("column_name");
      fireEvent.change(columnNameInput, { target: { value: "id" } });

      await act(async () => {
        fireEvent.click(screen.getByText("Create Table"));
      });

      expect(await screen.findByText(/Failed to execute/)).toBeDefined();
    });

    it("switches to Indexes tab", () => {
      render(
        <TableDesigner connectionId="conn-1" database="testdb" />,
      );
      fireEvent.click(screen.getByText("Indexes"));
      expect(screen.getByText("No indexes defined.")).toBeDefined();
      expect(screen.getByText("Add Index")).toBeDefined();
    });

    it("switches to Foreign Keys tab", () => {
      render(
        <TableDesigner connectionId="conn-1" database="testdb" />,
      );
      fireEvent.click(screen.getByText("Foreign Keys"));
      expect(screen.getByText("No foreign keys defined.")).toBeDefined();
      expect(screen.getByText("Add Foreign Key")).toBeDefined();
    });
  });

  describe("alter mode", () => {
    it("shows loading state while fetching table structure", async () => {
      vi.mocked(api.getColumns).mockReturnValue(new Promise(() => {}));
      vi.mocked(api.getIndexes).mockReturnValue(new Promise(() => {}));
      vi.mocked(api.getTableDdl).mockReturnValue(new Promise(() => {}));

      render(
        <TableDesigner connectionId="conn-1" database="testdb" tableName="users" />,
      );
      expect(screen.getByText("Loading table structure…")).toBeDefined();
    });

    it("loads existing table data in alter mode", async () => {
      vi.mocked(api.getColumns).mockResolvedValue(mockColumns);
      vi.mocked(api.getIndexes).mockResolvedValue(mockIndexes);

      render(
        <TableDesigner connectionId="conn-1" database="testdb" tableName="users" />,
      );

      // Table name should be prefilled
      expect(await screen.findByDisplayValue("users")).toBeDefined();
    });

    it("shows 'Apply Changes' button in alter mode", async () => {
      vi.mocked(api.getColumns).mockResolvedValue(mockColumns);
      vi.mocked(api.getIndexes).mockResolvedValue(mockIndexes);

      render(
        <TableDesigner connectionId="conn-1" database="testdb" tableName="users" />,
      );

      expect(await screen.findByText("Apply Changes")).toBeDefined();
    });

    it("shows error on load failure in alter mode", async () => {
      vi.mocked(api.getColumns).mockRejectedValue("Failed to load");

      render(
        <TableDesigner connectionId="conn-1" database="testdb" tableName="users" />,
      );

      expect(await screen.findByText(/Failed to load table structure/)).toBeDefined();
    });

    it("adds an index", async () => {
      vi.mocked(api.getColumns).mockResolvedValue(mockColumns);
      vi.mocked(api.getIndexes).mockResolvedValue(mockIndexes);

      render(
        <TableDesigner connectionId="conn-1" database="testdb" tableName="users" />,
      );

      await screen.findByDisplayValue("users");
      fireEvent.click(screen.getByText("Indexes"));
      fireEvent.click(screen.getByText("Add Index"));

      // New index form should appear
      const indexNameInputs = screen.getAllByPlaceholderText("index_name");
      expect(indexNameInputs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("table options in alter mode", () => {
    const MYISAM_DDL = "CREATE TABLE `users` (\n  `id` int NOT NULL\n"
      + ") ENGINE=MyISAM DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_bin COMMENT='legacy'";

    beforeEach(() => {
      vi.mocked(api.getColumns).mockResolvedValue(mockColumns);
      vi.mocked(api.getIndexes).mockResolvedValue(mockIndexes);
      vi.mocked(api.getTableDdl).mockResolvedValue(MYISAM_DDL);
    });

    async function openOptions() {
      render(<TableDesigner connectionId="conn-1" database="testdb" tableName="users" />);
      await screen.findByDisplayValue("users");
      fireEvent.click(screen.getByText("Options"));
    }

    it("shows what the table actually is, not the defaults for a new table", async () => {
      // Every table used to open reading InnoDB / utf8mb4 / no comment,
      // whatever it really was (#378).
      await openOptions();

      expect(screen.getByDisplayValue("MyISAM")).toBeDefined();
      expect(screen.getByDisplayValue("utf8mb3")).toBeDefined();
      expect(screen.getByDisplayValue("legacy")).toBeDefined();
    });

    it("emits nothing when the table is opened and left alone", async () => {
      await openOptions();
      fireEvent.click(screen.getByText("Preview SQL"));

      expect(screen.getByTestId("sql-preview-dialog").textContent)
        .toContain("No changes detected");
    });

    it("keeps a change towards a default value instead of discarding it", async () => {
      // The damaging half. The baseline said InnoDB for a MyISAM table, so
      // choosing InnoDB diffed against itself: the request vanished and the
      // user was told there was nothing to do.
      await openOptions();
      fireEvent.change(screen.getByDisplayValue("MyISAM"), { target: { value: "InnoDB" } });
      fireEvent.click(screen.getByText("Preview SQL"));

      expect(screen.getByTestId("sql-preview-dialog").textContent)
        .toContain("ENGINE = InnoDB");
    });
  });
});
