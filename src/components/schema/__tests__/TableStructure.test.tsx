import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TableStructure } from "../TableStructure";

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    getColumns: vi.fn(),
    getIndexes: vi.fn(),
    getTableDdl: vi.fn(),
    // FR-4.2.1's remaining tabs (#292).
    getForeignKeys: vi.fn(),
    getPartitions: vi.fn(),
    getTriggers: vi.fn(),
    getTables: vi.fn(),
  },
}));

vi.mock("@monaco-editor/react", () => ({
  default: ({ value }: { value: string }) => <div data-testid="monaco-editor">{value}</div>,
}));

import { api } from "../../../lib/tauri-api";
import { useSchemaStore } from "../../../stores/schemaStore";

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
  {
    name: "email",
    data_type: "varchar",
    column_type: "VARCHAR(255)",
    nullable: true,
    is_primary_key: false,
    default_value: "NULL",
    extra: "",
    comment: "",
  },
];

const mockIndexes = [
  { name: "PRIMARY", columns: ["id"], is_unique: true, index_type: "BTREE" },
  { name: "idx_name", columns: ["name"], is_unique: false, index_type: "BTREE" },
];

const mockDdl = "CREATE TABLE users (\n  id INT AUTO_INCREMENT PRIMARY KEY,\n  name VARCHAR(255)\n);";

/** A sub-tab button, named rather than matched by text: "Columns" is also an
 * Overview row label, and "Triggers" is both a tab and a count. */
const tab = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}`) });

describe("TableStructure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getColumns).mockResolvedValue(mockColumns);
    vi.mocked(api.getIndexes).mockResolvedValue(mockIndexes);
    vi.mocked(api.getTableDdl).mockResolvedValue(mockDdl);
    vi.mocked(api.getForeignKeys).mockResolvedValue([]);
    vi.mocked(api.getPartitions).mockResolvedValue([]);
    vi.mocked(api.getTriggers).mockResolvedValue([]);
    vi.mocked(api.getTables).mockResolvedValue([]);
    useSchemaStore.setState({ byConnection: {} });
  });

  it("shows loading state initially", () => {
    vi.mocked(api.getColumns).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.getIndexes).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.getTableDdl).mockReturnValue(new Promise(() => {}));
    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="users" />,
    );
    expect(screen.getByText("Loading…")).toBeDefined();
  });

  it("renders table header with database.table format", async () => {
    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="users" />,
    );
    expect(await screen.findByText("testdb.users")).toBeDefined();
  });

  it("shows every FR-4.2.1 category as a tab", async () => {
    // Three of the eight were here; the rest had nowhere to appear (#292).
    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="users" />,
    );
    await screen.findByText("testdb.users");
    for (
      const label of [
        "Overview",
        "Columns",
        "Indexes",
        "Foreign Keys",
        "Triggers",
        "Partitions",
        "DDL",
      ]
    ) {
      expect(tab(label)).toBeDefined();
    }
  });

  it("opens on Overview, because size and shape come before detail", async () => {
    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="users" />,
    );
    await screen.findByText("testdb.users");
    expect(tab("Overview").getAttribute("aria-pressed")).toBe("true");
  });

  it("renders columns table by default", async () => {
    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="users" />,
    );
    await screen.findByText("testdb.users");
    fireEvent.click(tab("Columns"));
    expect(await screen.findByText("id")).toBeDefined();
    expect(screen.getByText("name")).toBeDefined();
    expect(screen.getByText("email")).toBeDefined();
  });

  it("shows column types", async () => {
    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="users" />,
    );
    await screen.findByText("testdb.users");
    fireEvent.click(tab("Columns"));
    expect(await screen.findByText("INT")).toBeDefined();
    const varcharElements = screen.getAllByText("VARCHAR(255)");
    expect(varcharElements.length).toBeGreaterThanOrEqual(1);
  });

  it("switches to Indexes tab", async () => {
    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="users" />,
    );
    await screen.findByText("testdb.users");
    fireEvent.click(tab("Indexes"));
    expect(screen.getByText("PRIMARY")).toBeDefined();
    expect(screen.getByText("idx_name")).toBeDefined();
    // Primary key should show unique badge
    expect(screen.getByText("UNIQUE")).toBeDefined();
  });

  it("switches to DDL tab", async () => {
    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="users" />,
    );
    await screen.findByText("testdb.users");
    fireEvent.click(tab("DDL"));
    expect(screen.getByTestId("monaco-editor")).toBeDefined();
  });

  it("shows the failure on the tab that failed", async () => {
    vi.mocked(api.getColumns).mockRejectedValue("Table not found");

    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="nonexistent" />,
    );
    await screen.findByText("testdb.nonexistent");
    fireEvent.click(tab("Columns"));

    expect(screen.getByText("Table not found")).toBeDefined();
  });

  it("keeps the other tabs working when one read fails", async () => {
    // A user without rights on information_schema.PARTITIONS should still see
    // their columns (F3.14 of #299).
    vi.mocked(api.getPartitions).mockRejectedValue("Access denied");

    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="users" />,
    );
    await screen.findByText("testdb.users");

    fireEvent.click(tab("Columns"));
    expect(screen.getByText("id")).toBeDefined();

    fireEvent.click(tab("Partitions"));
    expect(screen.getByRole("alert")).toHaveTextContent("Access denied");
  });

  it("shows 'No columns found' when columns array is empty", async () => {
    vi.mocked(api.getColumns).mockResolvedValue([]);
    vi.mocked(api.getIndexes).mockResolvedValue([]);
    vi.mocked(api.getTableDdl).mockResolvedValue("");

    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="empty_table" />,
    );
    await screen.findByText("testdb.empty_table");
    fireEvent.click(tab("Columns"));
    expect(screen.getByText("This table has no columns.")).toBeDefined();
  });

  it("shows 'No indexes found' when indexes array is empty", async () => {
    vi.mocked(api.getIndexes).mockResolvedValue([]);
    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="users" />,
    );
    await screen.findByText("testdb.users");
    fireEvent.click(tab("Indexes"));
    expect(screen.getByText("This table has no indexes.")).toBeDefined();
  });
});

describe("TableStructure details (#292)", () => {
  const foreignKeys = [{
    name: "fk_owner",
    columns: ["owner_id", "tenant_id"],
    referenced_table: "users",
    referenced_columns: ["id", "tenant"],
    on_update: "CASCADE",
    on_delete: "SET NULL",
  }];
  const partitions = [
    {
      name: "p_old",
      method: "RANGE",
      expression: "created_year",
      description: "2020",
      row_count: 4200,
      data_size: 1048576,
    },
  ];
  const triggers = [
    { name: "users_audit", table: "users", timing: "AFTER", event: "INSERT" },
    { name: "other_audit", table: "orders", timing: "BEFORE", event: "UPDATE" },
  ];
  const tables = [{
    name: "users",
    table_type: "BASE TABLE",
    engine: "InnoDB",
    row_count: 4200,
    data_size: 1048576,
    comment: "people",
  }];

  beforeEach(() => {
    vi.clearAllMocks();
    useSchemaStore.setState({ byConnection: {} });
    vi.mocked(api.getColumns).mockResolvedValue(mockColumns);
    vi.mocked(api.getIndexes).mockResolvedValue(mockIndexes);
    vi.mocked(api.getTableDdl).mockResolvedValue(mockDdl);
    vi.mocked(api.getForeignKeys).mockResolvedValue(foreignKeys as never);
    vi.mocked(api.getPartitions).mockResolvedValue(partitions as never);
    vi.mocked(api.getTriggers).mockResolvedValue(triggers as never);
    vi.mocked(api.getTables).mockResolvedValue(tables as never);
  });

  const open = async () => {
    render(<TableStructure connectionId="conn-1" database="testdb" tableName="users" />);
    await screen.findByText("testdb.users");
  };

  describe("overview", () => {
    it("answers how big the table is and what it is", async () => {
      await open();
      expect(screen.getByText("4,200")).toBeInTheDocument();
      expect(screen.getByText("1.0 MB")).toBeInTheDocument();
      expect(screen.getByText("InnoDB")).toBeInTheDocument();
      expect(screen.getByText("people")).toBeInTheDocument();
    });

    it("says the row count is approximate", async () => {
      // InnoDB samples it from the index and it can be well out; presenting
      // it as exact invites someone to trust it for a count.
      await open();
      expect(screen.getByText("(approximate)")).toBeInTheDocument();
    });

    it("says a table is not partitioned rather than showing zero", async () => {
      vi.mocked(api.getPartitions).mockResolvedValue([]);
      await open();
      expect(screen.getByText("not partitioned")).toBeInTheDocument();
    });
  });

  describe("foreign keys", () => {
    it("shows the columns, what they reference, and the rules", async () => {
      // The rules are what people come for: whether deleting a parent row
      // takes its children with it is not visible anywhere else.
      await open();
      fireEvent.click(tab("Foreign Keys"));

      expect(screen.getByText("fk_owner")).toBeInTheDocument();
      expect(screen.getByText("owner_id, tenant_id")).toBeInTheDocument();
      expect(screen.getByText("users (id, tenant)")).toBeInTheDocument();
      expect(screen.getByText("CASCADE")).toBeInTheDocument();
      expect(screen.getByText("SET NULL")).toBeInTheDocument();
    });

    it("says so when there are none", async () => {
      vi.mocked(api.getForeignKeys).mockResolvedValue([]);
      await open();
      fireEvent.click(tab("Foreign Keys"));
      expect(screen.getByText("This table has no foreign keys.")).toBeInTheDocument();
    });
  });

  describe("triggers", () => {
    it("shows only this table's", async () => {
      // The server has no per-table trigger query; the database's list is
      // filtered here, and showing another table's would be wrong.
      await open();
      fireEvent.click(tab("Triggers"));

      expect(screen.getByText("users_audit")).toBeInTheDocument();
      expect(screen.queryByText("other_audit")).toBeNull();
    });
  });

  describe("partitions", () => {
    it("shows the bound and the size of each", async () => {
      await open();
      fireEvent.click(tab("Partitions"));

      expect(screen.getByText("p_old")).toBeInTheDocument();
      expect(screen.getByText("2020")).toBeInTheDocument();
      expect(screen.getByText("1.0 MB")).toBeInTheDocument();
    });
  });

  it("keeps a tab that has nothing in it, rather than hiding it", async () => {
    // A panel whose tabs change per table is one you cannot learn.
    vi.mocked(api.getForeignKeys).mockResolvedValue([]);
    vi.mocked(api.getPartitions).mockResolvedValue([]);
    await open();

    expect(tab("Foreign Keys")).toBeInTheDocument();
    expect(tab("Partitions")).toBeInTheDocument();
  });

  it("counts what each tab holds", async () => {
    await open();
    expect(tab("Foreign Keys").textContent).toContain("1");
    expect(tab("Columns").textContent).toContain("3");
  });
});
