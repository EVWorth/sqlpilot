import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TableDesigner } from "../TableDesigner";

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    getTables: vi.fn(),
    getColumns: vi.fn(),
    getIndexes: vi.fn(),
    getForeignKeys: vi.fn(),
    getTableDdl: vi.fn(),
    executeQuery: vi.fn(),
  },
}));

vi.mock("../../../stores/resultStore", () => ({
  useResultStore: { getState: vi.fn() },
}));

vi.mock("../../common/SQLPreviewDialog", () => ({
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
    vi.mocked(api.getForeignKeys).mockResolvedValue([]);
    vi.mocked(api.getTableDdl).mockResolvedValue(
      "CREATE TABLE `users` (\n  `id` int NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci",
    );
    vi.mocked(useResultStore.getState).mockReturnValue({
      executeQuery: vi.fn().mockResolvedValue({ status: "succeeded", results: [] }),
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
      const before = screen.getAllByPlaceholderText("column_name").length;
      const trashButtons = screen.getAllByRole("button", { name: /^Remove column/ });
      expect(trashButtons).toHaveLength(before);

      fireEvent.click(trashButtons[trashButtons.length - 1]);

      expect(screen.getAllByPlaceholderText("column_name")).toHaveLength(before - 1);
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
        executeQuery: vi.fn().mockResolvedValue({ status: "failed", error: "SQL error" }),
        error: null,
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
      vi.mocked(api.getForeignKeys).mockReturnValue(new Promise(() => {}));

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

    describe("when part of the table cannot be read (#796)", () => {
      it("offers Retry and no Apply or Preview when the columns fail", async () => {
        vi.mocked(api.getIndexes).mockResolvedValue(mockIndexes);
        vi.mocked(api.getColumns).mockRejectedValueOnce("denied").mockResolvedValue(mockColumns);

        render(<TableDesigner connectionId="conn-1" database="testdb" tableName="users" />);

        expect(await screen.findByRole("alert")).toHaveTextContent(/Failed to load table structure: denied/);
        expect(screen.queryByText("Apply Changes")).toBeNull();
        expect(screen.queryByText("Preview SQL")).toBeNull();

        await act(async () => {
          fireEvent.click(screen.getByText("Retry"));
        });
        expect(await screen.findByDisplayValue("users")).toBeDefined();
        expect(screen.getByText("Apply Changes")).toBeDefined();
      });

      it("blocks the form when the DDL fails", async () => {
        vi.mocked(api.getColumns).mockResolvedValue(mockColumns);
        vi.mocked(api.getIndexes).mockResolvedValue(mockIndexes);
        vi.mocked(api.getTableDdl).mockRejectedValue("no SHOW CREATE");

        render(<TableDesigner connectionId="conn-1" database="testdb" tableName="users" />);

        expect(await screen.findByRole("alert")).toHaveTextContent(/no SHOW CREATE/);
        expect(screen.queryByText("Apply Changes")).toBeNull();
      });

      it("keeps the columns when only the foreign keys fail, and never emits CREATE TABLE", async () => {
        vi.mocked(api.getColumns).mockResolvedValue(mockColumns);
        vi.mocked(api.getIndexes).mockResolvedValue(mockIndexes);
        vi.mocked(api.getForeignKeys).mockRejectedValue("information_schema denied");

        render(<TableDesigner connectionId="conn-1" database="testdb" tableName="users" />);

        expect(await screen.findByDisplayValue("users")).toBeDefined();
        expect(screen.getByDisplayValue("id")).toBeDefined();
        expect(screen.getByRole("status")).toHaveTextContent(/foreign keys/);
        fireEvent.click(screen.getByText("Preview SQL"));
        const preview = screen.getByTestId("sql-preview-dialog").textContent ?? "";
        expect(preview).not.toContain("CREATE TABLE");
        expect(preview).toContain("No changes detected");
      });
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
      vi.mocked(api.getForeignKeys).mockResolvedValue([]);
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

  describe("column modifiers (#814)", () => {
    const ordersColumns = [
      {
        name: "id",
        data_type: "int",
        column_type: "int unsigned",
        nullable: false,
        is_primary_key: true,
        default_value: null,
        extra: "auto_increment",
        comment: "",
        charset: null,
        collation: null,
      },
      {
        name: "customer_id",
        data_type: "int",
        column_type: "int unsigned",
        nullable: false,
        is_primary_key: false,
        default_value: null,
        extra: "",
        comment: "",
        charset: null,
        collation: null,
      },
      {
        name: "status",
        data_type: "varchar",
        column_type: "varchar(16)",
        nullable: false,
        is_primary_key: false,
        default_value: null,
        extra: "",
        comment: "",
        charset: "utf8mb4",
        collation: "utf8mb4_0900_ai_ci",
      },
      {
        name: "updated_at",
        data_type: "timestamp",
        column_type: "timestamp",
        nullable: true,
        is_primary_key: false,
        default_value: "CURRENT_TIMESTAMP",
        extra: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP",
        comment: "",
        charset: null,
        collation: null,
      },
    ];

    const preview = () => {
      fireEvent.click(screen.getByText("Preview SQL"));
      return screen.getByTestId("sql-preview-dialog").textContent ?? "";
    };

    async function openOrders() {
      vi.mocked(api.getColumns).mockResolvedValue(ordersColumns as never);
      vi.mocked(api.getIndexes).mockResolvedValue(mockIndexes);
      render(<TableDesigner connectionId="conn-1" database="shop" tableName="orders" />);
      await screen.findByDisplayValue("orders");
    }

    it("shows a loaded column's UNSIGNED", async () => {
      await openOrders();

      expect((screen.getByLabelText("Unsigned: customer_id") as HTMLInputElement).checked).toBe(true);
      expect((screen.getByLabelText("Unsigned: status") as HTMLInputElement).disabled).toBe(true);
    });

    it("drops UNSIGNED when it is unticked, and marks the row as changed", async () => {
      await openOrders();
      const box = screen.getByLabelText("Unsigned: customer_id");

      fireEvent.click(box);

      expect(box.closest("tr")?.className).toContain("bg-brand-600/5");
      const sql = preview();
      expect(sql).toContain("MODIFY COLUMN `customer_id` INT NOT NULL");
      expect(sql).not.toContain("`customer_id` INT UNSIGNED");
    });

    it("does not count ticking and unticking as a change", async () => {
      await openOrders();
      const box = screen.getByLabelText("Unsigned: status");
      // Disabled for a VARCHAR; use one that takes it and has none.
      expect(box).toBeDisabled();
      fireEvent.click(screen.getByLabelText("More options for customer_id"));
      const zerofill = screen.getByLabelText("Zerofill: customer_id");
      fireEvent.click(zerofill);
      fireEvent.click(zerofill);

      expect(preview()).toContain("No changes detected");
    });

    it("makes a new column unsigned", () => {
      render(<TableDesigner connectionId="conn-1" database="testdb" />);
      fireEvent.change(screen.getAllByPlaceholderText("table_name")[0], { target: { value: "t" } });
      fireEvent.change(screen.getByPlaceholderText("column_name"), { target: { value: "n" } });

      fireEvent.click(screen.getByLabelText("Unsigned: n"));

      expect(preview()).toContain("`n` INT UNSIGNED NULL");
    });

    it("edits charset, collation and ON UPDATE in the row's details", async () => {
      await openOrders();
      expect(screen.getAllByTestId("column-details-set")).toHaveLength(2);

      fireEvent.click(screen.getByLabelText("More options for status"));
      expect((screen.getByLabelText("Collation of status") as HTMLSelectElement).value).toBe("utf8mb4_0900_ai_ci");
      fireEvent.change(screen.getByLabelText("Collation of status"), { target: { value: "utf8mb4_bin" } });

      fireEvent.click(screen.getByLabelText("More options for updated_at"));
      expect(screen.getByLabelText("On update of updated_at")).toHaveValue("CURRENT_TIMESTAMP");
      fireEvent.change(screen.getByLabelText("On update of updated_at"), { target: { value: "" } });

      const sql = preview();
      expect(sql).toContain("MODIFY COLUMN `status` VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL");
      expect(sql).toMatch(/MODIFY COLUMN `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP(?! ON UPDATE)/);
    });

    it("marks the primary key, and edits it from the column", async () => {
      await openOrders();

      expect(screen.getByLabelText("Primary key: id")).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByLabelText("Primary key: customer_id")).toHaveAttribute("aria-pressed", "false");

      fireEvent.click(screen.getByLabelText("Primary key: customer_id"));

      expect(preview()).toContain("ADD PRIMARY KEY (`id`, `customer_id`)");
    });

    it("creates a primary key from the column in a new table", () => {
      render(<TableDesigner connectionId="conn-1" database="testdb" />);
      fireEvent.change(screen.getAllByPlaceholderText("table_name")[0], { target: { value: "t" } });
      fireEvent.change(screen.getByPlaceholderText("column_name"), { target: { value: "id" } });

      fireEvent.click(screen.getByLabelText("Primary key: id"));

      const sql = preview();
      expect(sql).toContain("`id` INT NOT NULL");
      expect(sql).toContain("PRIMARY KEY (`id`)");
    });
  });

  describe("composite index order (#829)", () => {
    function twoColumnIndex() {
      render(<TableDesigner connectionId="conn-1" database="testdb" />);
      fireEvent.change(screen.getAllByPlaceholderText("table_name")[0], { target: { value: "orders" } });
      fireEvent.change(screen.getByPlaceholderText("column_name"), { target: { value: "status" } });
      fireEvent.click(screen.getByText("Add Column"));
      fireEvent.change(screen.getAllByPlaceholderText("column_name")[1], { target: { value: "placed_at" } });
      fireEvent.click(screen.getByText("Indexes"));
      fireEvent.click(screen.getByText("Add Index"));
      fireEvent.change(screen.getByPlaceholderText("index_name"), { target: { value: "idx_s" } });
      // Clicked in the opposite order to the table's.
      fireEvent.click(screen.getByRole("button", { name: "placed_at" }));
      fireEvent.click(screen.getByRole("button", { name: /status$/ }));
    }

    const preview = () => {
      fireEvent.click(screen.getByText("Preview SQL"));
      return screen.getByTestId("sql-preview-dialog").textContent ?? "";
    };

    it("numbers the chosen columns in key order", () => {
      twoColumnIndex();

      expect(screen.getByRole("button", { name: /placed_at$/ }).textContent).toBe("1placed_at");
      expect(screen.getByRole("button", { name: /status$/ }).textContent).toBe("2status");
      expect(
        within(screen.getByRole("list", { name: "Key order" })).getAllByRole("listitem").map((li) => li.textContent),
      ).toEqual(["1.placed_at", "2.status"]);
      expect(preview()).toContain("(`placed_at`, `status`)");
    });

    it("reorders the key", () => {
      twoColumnIndex();

      fireEvent.click(screen.getByLabelText("Move status up"));

      expect(screen.getByRole("button", { name: /status$/ }).textContent).toBe("1status");
      expect(preview()).toContain("(`status`, `placed_at`)");
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
      fireEvent.click(screen.getByText("Apply Changes"));
      await act(async () => {
        fireEvent.click(screen.getByText("Execute Preview"));
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
        executeQuery: vi.fn().mockResolvedValue({ status: "awaiting-confirmation" }),
        error: null,
        confirmDialog: { isOpen: true, kind: "query", connectionId: "conn-1", sql: "ALTER ..." },
      } as never);

      await editAndSave();

      // Nothing has run yet, so saying it worked would be a lie.
      expect(screen.queryByText("Table saved successfully!")).toBeNull();
    });

    it("reports a failure from the store rather than reporting success", async () => {
      vi.mocked(useResultStore.getState).mockReturnValue({
        executeQuery: vi.fn().mockResolvedValue({ status: "failed", error: "Duplicate column name 'added'" }),
        error: null,
        confirmDialog: null,
      } as never);

      await editAndSave();

      expect(screen.getByText(/Duplicate column name/)).toBeDefined();
      expect(screen.queryByText("Table saved successfully!")).toBeNull();
    });

    it("claims nothing for a cancelled save", async () => {
      vi.mocked(useResultStore.getState).mockReturnValue({
        executeQuery: vi.fn().mockResolvedValue({ status: "cancelled" }),
        error: null,
        confirmDialog: null,
      } as never);

      await editAndSave();

      expect(screen.getByText(/Cancelled before the change was confirmed/)).toBeDefined();
      expect(screen.queryByText("Table saved successfully!")).toBeNull();
    });

    it("goes by its own run's outcome, not the error on screen", async () => {
      // #842: the store's `error` is the shown tab's, so another tab's
      // failure there was reported as this save's.
      vi.mocked(useResultStore.getState).mockReturnValue({
        executeQuery: vi.fn().mockResolvedValue({ status: "succeeded", results: [] }),
        error: "another tab's failure",
        confirmDialog: null,
      } as never);

      await editAndSave();

      expect(await screen.findByText("Table saved successfully!")).toBeDefined();
      expect(screen.queryByText(/another tab's failure/)).toBeNull();
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

    it("shows an alter as well, and runs nothing until Execute", async () => {
      // A misclicked trash icon followed by Apply dropped the column at once,
      // with no preview, on any connection not marked production (#791).
      vi.mocked(api.getColumns).mockResolvedValue(mockColumns);
      vi.mocked(api.getIndexes).mockResolvedValue(mockIndexes);

      render(<TableDesigner connectionId="conn-1" database="testdb" tableName="users" />);
      // The table name is a prop and shows at once; the columns load after,
      // so wait for the row itself (#923).
      fireEvent.click(await screen.findByLabelText("Remove column name"));
      await act(async () => {
        fireEvent.click(screen.getByText("Apply Changes"));
      });

      expect(screen.getByTestId("sql-preview-dialog").textContent)
        .toContain("DROP COLUMN `name`");
      expect(useResultStore.getState().executeQuery).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(screen.getByText("Close Preview"));
      });
      expect(useResultStore.getState().executeQuery).not.toHaveBeenCalled();
    });
  });

  describe("the form refuses to build invalid DDL", () => {
    it("keeps a type the dropdown has never heard of", async () => {
      // Unknown types used to become VARCHAR. A BIT(8) column saved back that
      // way turned b'10101010' into the string "170" on MySQL 8 (#382).
      vi.mocked(api.getColumns).mockResolvedValue([
        {
          name: "b",
          data_type: "bit",
          column_type: "bit(8)",
          nullable: true,
          default_value: null,
          is_primary_key: false,
          extra: "",
          comment: "",
          charset: null,
          collation: null,
        },
      ] as never);
      vi.mocked(api.getIndexes).mockResolvedValue([]);

      render(<TableDesigner connectionId="conn-1" database="testdb" tableName="users" />);
      expect(await screen.findByDisplayValue("BIT")).toBeDefined();
      expect(screen.getByDisplayValue("8")).toBeDefined();
    });

    it("will not let a VARCHAR be marked auto-increment", async () => {
      render(<TableDesigner connectionId="conn-1" database="testdb" />);
      const typeSelect = screen.getAllByDisplayValue("INT")[0];
      fireEvent.change(typeSelect, { target: { value: "VARCHAR" } });

      const boxes = screen.getAllByRole("checkbox");
      const autoInc = boxes[boxes.length - 1];
      expect((autoInc as HTMLInputElement).disabled).toBe(true);
      expect(autoInc.getAttribute("title")).toContain("integer type");
    });

    it("allows it on an integer column", async () => {
      render(<TableDesigner connectionId="conn-1" database="testdb" />);
      const boxes = screen.getAllByRole("checkbox");
      expect((boxes[boxes.length - 1] as HTMLInputElement).disabled).toBe(false);
    });

    it("says so when a second primary key is added", async () => {
      // MySQL answers a second one with ERROR 1068, and the only sign used to
      // be the save failing (#384).
      render(<TableDesigner connectionId="conn-1" database="testdb" />);
      fireEvent.click(screen.getByText("Indexes"));
      fireEvent.click(screen.getByText("Add Index"));
      fireEvent.click(screen.getByText("Add Index"));

      const types = screen.getAllByDisplayValue("INDEX");
      fireEvent.change(types[0], { target: { value: "PRIMARY KEY" } });
      fireEvent.change(types[1], { target: { value: "PRIMARY KEY" } });

      expect(screen.getByTestId("index-problem").textContent)
        .toContain("only one primary key");
    });

    it("says so when two indexes share a name", async () => {
      render(<TableDesigner connectionId="conn-1" database="testdb" />);
      fireEvent.click(screen.getByText("Indexes"));
      fireEvent.click(screen.getByText("Add Index"));
      fireEvent.click(screen.getByText("Add Index"));

      const names = screen.getAllByPlaceholderText("index_name");
      fireEvent.change(names[0], { target: { value: "idx_same" } });
      fireEvent.change(names[1], { target: { value: "idx_same" } });

      const problems = screen.getAllByTestId("index-problem");
      expect(problems).toHaveLength(2);
      expect(problems[0].textContent).toContain("already called");
    });

    it("says nothing about a single well-formed index", async () => {
      render(<TableDesigner connectionId="conn-1" database="testdb" />);
      fireEvent.click(screen.getByText("Indexes"));
      fireEvent.click(screen.getByText("Add Index"));
      fireEvent.change(screen.getByPlaceholderText("index_name"), {
        target: { value: "idx_ok" },
      });

      expect(screen.queryByTestId("index-problem")).toBeNull();
    });
  });

  describe("foreign keys", () => {
    const existingFk = {
      name: "orders_ibfk_1",
      columns: ["user_id"],
      referenced_table: "users",
      referenced_columns: ["id"],
      on_update: "NO ACTION",
      on_delete: "CASCADE",
    };

    beforeEach(() => {
      vi.mocked(api.getColumns).mockResolvedValue(mockColumns);
      vi.mocked(api.getIndexes).mockResolvedValue(mockIndexes);
    });

    it("shows the ones the table already has", async () => {
      // The tab was empty for every table — the Rust type existed with
      // nothing producing it — so an existing constraint could not be seen,
      // edited or removed (#386).
      vi.mocked(api.getForeignKeys).mockResolvedValue([existingFk] as never);

      render(<TableDesigner connectionId="conn-1" database="testdb" tableName="orders" />);
      await screen.findByDisplayValue("orders");
      fireEvent.click(screen.getByText("Foreign Keys"));

      expect(screen.getByDisplayValue("orders_ibfk_1")).toBeDefined();
      expect(screen.getByDisplayValue("CASCADE")).toBeDefined();
    });

    it("treats an untouched foreign key as no change", async () => {
      // The baseline was always empty, so a loaded key looked newly added.
      vi.mocked(api.getForeignKeys).mockResolvedValue([existingFk] as never);

      render(<TableDesigner connectionId="conn-1" database="testdb" tableName="orders" />);
      await screen.findByDisplayValue("orders");
      fireEvent.click(screen.getByText("Preview SQL"));

      expect(screen.getByTestId("sql-preview-dialog").textContent)
        .toContain("No changes detected");
    });

    it("emits a drop and an add when a referential action changes", async () => {
      vi.mocked(api.getForeignKeys).mockResolvedValue([existingFk] as never);

      render(<TableDesigner connectionId="conn-1" database="testdb" tableName="orders" />);
      await screen.findByDisplayValue("orders");
      fireEvent.click(screen.getByText("Foreign Keys"));
      fireEvent.change(screen.getByDisplayValue("CASCADE"), { target: { value: "SET NULL" } });
      fireEvent.click(screen.getByText("Preview SQL"));

      const sql = screen.getByTestId("sql-preview-dialog").textContent ?? "";
      expect(sql).toContain("DROP FOREIGN KEY `orders_ibfk_1`");
      expect(sql).toContain("ON DELETE SET NULL");
    });

    it("warns when the two sides cannot be the same kind of type", async () => {
      // MySQL answers this with ERROR 1215 at save time and names neither
      // the column nor the reason (#385).
      vi.mocked(api.getForeignKeys).mockResolvedValue([{
        ...existingFk,
        columns: ["name"],
      }] as never);
      vi.mocked(api.getColumns).mockImplementation(
        ((_c: string, _d: string, table: string) =>
          Promise.resolve(
            table === "users"
              ? [{
                name: "id",
                data_type: "int",
                column_type: "int",
                nullable: false,
                default_value: null,
                is_primary_key: true,
                extra: "",
                comment: "",
                charset: null,
                collation: null,
              }]
              : mockColumns,
          )) as never,
      );

      render(<TableDesigner connectionId="conn-1" database="testdb" tableName="orders" />);
      await screen.findByDisplayValue("orders");
      await act(async () => {
        fireEvent.click(screen.getByText("Foreign Keys"));
      });

      expect(screen.getByTestId("fk-problem").textContent).toContain("same kind of type");
    });

    it("keeps the referenced column and says why when its table's columns fail (#810)", async () => {
      // The load error was swallowed, so the card showed the table and no
      // chips at all: the key's target could be neither seen nor changed.
      vi.mocked(api.getForeignKeys).mockResolvedValue([existingFk] as never);
      vi.mocked(api.getColumns).mockImplementation(
        ((_c: string, _d: string, table: string) =>
          table === "users" ? Promise.reject("access denied") : Promise.resolve(mockColumns)) as never,
      );

      render(<TableDesigner connectionId="conn-1" database="testdb" tableName="orders" />);
      await screen.findByDisplayValue("orders");
      await act(async () => {
        fireEvent.click(screen.getByText("Foreign Keys"));
      });

      expect(screen.getByRole("alert").textContent)
        .toContain("Couldn't load columns of users: access denied");
      // The first "id" chip is the local column list; the second is the
      // reference side, which must still be there and selected.
      const row = screen.getByTestId("fk-row");
      const idChips = within(row).getAllByRole("button", { name: "id" });
      expect(idChips).toHaveLength(2);
      expect(idChips[1].className).toContain("border-brand-500");
      expect(within(row).getAllByRole("button", { name: "name" })).toHaveLength(1);

      vi.mocked(api.getColumns).mockResolvedValue(mockColumns);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      });

      expect(screen.queryByRole("alert")).toBeNull();
      expect(within(row).getAllByRole("button", { name: "name" })).toHaveLength(2);
    });
  });
});
