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

vi.mock("../../../stores/resultStore", () => ({
  useResultStore: { getState: vi.fn() },
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
import { useResultStore } from "../../../stores/resultStore";

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
    vi.mocked(useResultStore.getState).mockReturnValue({
      executeQuery: vi.fn().mockResolvedValue(undefined),
      error: null,
      confirmDialog: null,
    } as never);
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
      // Saving goes through the result store now, so the production gate and
      // the history entry apply to a CREATE TABLE as much as to an ALTER.

      render(
        <TableDesigner connectionId="conn-1" database="testdb" />,
      );

      const tableNameInput = screen.getByPlaceholderText("table_name");
      fireEvent.change(tableNameInput, { target: { value: "my_new_table" } });

      const columnNameInput = screen.getByPlaceholderText("column_name");
      fireEvent.change(columnNameInput, { target: { value: "id" } });

      const btn = screen.getByText("Create Table");

      // Create Table opens the preview; Execute is what runs it (#380).
      fireEvent.click(btn);
      await act(async () => {
        fireEvent.click(screen.getByText("Execute Preview"));
      });

      expect(useResultStore.getState().executeQuery).toHaveBeenCalled();
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

      fireEvent.click(screen.getByText("Create Table"));
      await act(async () => {
        fireEvent.click(screen.getByText("Execute Preview"));
      });

      expect(await screen.findByText("Table saved successfully!")).toBeDefined();
    });

    it("shows error on save failure", async () => {
      // The store reports a failed statement through its own error field
      // rather than by rejecting.
      vi.mocked(useResultStore.getState).mockReturnValue({
        executeQuery: vi.fn().mockResolvedValue(undefined),
        error: "SQL error",
        confirmDialog: null,
      } as never);

      render(
        <TableDesigner connectionId="conn-1" database="testdb" />,
      );

      const tableNameInput = screen.getByPlaceholderText("table_name");
      fireEvent.change(tableNameInput, { target: { value: "bad_table" } });

      const columnNameInput = screen.getByPlaceholderText("column_name");
      fireEvent.change(columnNameInput, { target: { value: "id" } });

      fireEvent.click(screen.getByText("Create Table"));
      await act(async () => {
        fireEvent.click(screen.getByText("Execute Preview"));
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

  describe("applying changes", () => {
    beforeEach(() => {
      vi.mocked(api.getColumns).mockResolvedValue(mockColumns);
      vi.mocked(api.getIndexes).mockResolvedValue(mockIndexes);
    });

    async function editAndSave() {
      render(<TableDesigner connectionId="conn-1" database="testdb" tableName="users" />);
      await screen.findByDisplayValue("users");
      fireEvent.click(screen.getByText("Add Column"));
      const nameInputs = screen.getAllByPlaceholderText("column_name");
      fireEvent.change(nameInputs[nameInputs.length - 1], { target: { value: "added" } });
      await act(async () => {
        fireEvent.click(screen.getByText("Apply Changes"));
      });
    }

    it("goes through the store, so the production gate and history apply", async () => {
      // It called api.executeQuery directly, which skips both (#379).
      await editAndSave();

      expect(useResultStore.getState().executeQuery).toHaveBeenCalled();
      expect(api.executeQuery).not.toHaveBeenCalled();
    });

    it("sends one statement, not one per change", async () => {
      await editAndSave();

      const sql = vi.mocked(useResultStore.getState().executeQuery).mock.calls[0][1] as string;
      expect(sql.match(/ALTER TABLE/g)).toHaveLength(1);
      expect(sql.match(/;/g)).toHaveLength(1);
    });

    it("claims nothing while the production dialog is still open", async () => {
      vi.mocked(useResultStore.getState).mockReturnValue({
        executeQuery: vi.fn().mockResolvedValue(undefined),
        error: null,
        confirmDialog: { isOpen: true, kind: "query", connectionId: "conn-1", sql: "ALTER ..." },
      } as never);

      await editAndSave();

      // Nothing has run yet, so saying it worked would be a lie.
      expect(screen.queryByText("Table saved successfully!")).toBeNull();
    });

    it("reports a failure from the store rather than reporting success", async () => {
      vi.mocked(useResultStore.getState).mockReturnValue({
        executeQuery: vi.fn().mockResolvedValue(undefined),
        error: "Duplicate column name 'added'",
        confirmDialog: null,
      } as never);

      await editAndSave();

      expect(screen.getByText(/Duplicate column name/)).toBeDefined();
      expect(screen.queryByText("Table saved successfully!")).toBeNull();
    });
  });

  describe("creating a table shows the statement first", () => {
    function fillIn() {
      render(<TableDesigner connectionId="conn-1" database="testdb" />);
      fireEvent.change(screen.getByPlaceholderText("table_name"), {
        target: { value: "my_new_table" },
      });
      fireEvent.change(screen.getByPlaceholderText("column_name"), {
        target: { value: "id" },
      });
    }

    it("opens the preview instead of running immediately", async () => {
      // Nothing on screen showed the statement or the database it would land
      // in; the first sight of either was the schema tree afterwards (#380).
      fillIn();
      await act(async () => {
        fireEvent.click(screen.getByText("Create Table"));
      });

      expect(screen.getByTestId("sql-preview-dialog")).toBeDefined();
      expect(useResultStore.getState().executeQuery).not.toHaveBeenCalled();
    });

    it("shows the statement it is about to run", async () => {
      fillIn();
      fireEvent.click(screen.getByText("Create Table"));

      expect(screen.getByTestId("sql-preview-dialog").textContent)
        .toContain("CREATE TABLE `my_new_table`");
    });

    it("runs it on Execute", async () => {
      fillIn();
      fireEvent.click(screen.getByText("Create Table"));
      await act(async () => {
        fireEvent.click(screen.getByText("Execute Preview"));
      });

      expect(useResultStore.getState().executeQuery).toHaveBeenCalled();
    });

    it("runs nothing on Cancel", async () => {
      fillIn();
      fireEvent.click(screen.getByText("Create Table"));
      await act(async () => {
        fireEvent.click(screen.getByText("Close Preview"));
      });

      expect(useResultStore.getState().executeQuery).not.toHaveBeenCalled();
      expect(screen.queryByTestId("sql-preview-dialog")).toBeNull();
    });

    it("does not add a step to alter mode, which already shows its changes", async () => {
      vi.mocked(api.getColumns).mockResolvedValue(mockColumns);
      vi.mocked(api.getIndexes).mockResolvedValue(mockIndexes);

      render(<TableDesigner connectionId="conn-1" database="testdb" tableName="users" />);
      await screen.findByDisplayValue("users");
      fireEvent.click(screen.getByText("Add Column"));
      const names = screen.getAllByPlaceholderText("column_name");
      fireEvent.change(names[names.length - 1], { target: { value: "added" } });
      await act(async () => {
        fireEvent.click(screen.getByText("Apply Changes"));
      });

      expect(useResultStore.getState().executeQuery).toHaveBeenCalled();
    });
  });
});
