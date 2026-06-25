import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TableStructure } from "../TableStructure";

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    getColumns: vi.fn(),
    getIndexes: vi.fn(),
    getTableDdl: vi.fn(),
  },
}));

vi.mock("@monaco-editor/react", () => ({
  default: ({ value }: { value: string }) => <div data-testid="monaco-editor">{value}</div>,
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

describe("TableStructure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getColumns).mockResolvedValue(mockColumns);
    vi.mocked(api.getIndexes).mockResolvedValue(mockIndexes);
    vi.mocked(api.getTableDdl).mockResolvedValue(mockDdl);
  });

  it("shows loading state initially", () => {
    vi.mocked(api.getColumns).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.getIndexes).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.getTableDdl).mockReturnValue(new Promise(() => {}));
    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="users" />,
    );
    expect(screen.getByText("Loading structure…")).toBeDefined();
  });

  it("renders table header with database.table format", async () => {
    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="users" />,
    );
    expect(await screen.findByText("testdb.users")).toBeDefined();
  });

  it("shows sub-tabs: Columns, Indexes, DDL", async () => {
    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="users" />,
    );
    await screen.findByText("testdb.users");
    expect(screen.getByText("Columns")).toBeDefined();
    expect(screen.getByText("Indexes")).toBeDefined();
    expect(screen.getByText("DDL")).toBeDefined();
  });

  it("renders columns table by default", async () => {
    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="users" />,
    );
    expect(await screen.findByText("id")).toBeDefined();
    expect(screen.getByText("name")).toBeDefined();
    expect(screen.getByText("email")).toBeDefined();
  });

  it("shows column types", async () => {
    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="users" />,
    );
    expect(await screen.findByText("INT")).toBeDefined();
    const varcharElements = screen.getAllByText("VARCHAR(255)");
    expect(varcharElements.length).toBeGreaterThanOrEqual(1);
  });

  it("switches to Indexes tab", async () => {
    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="users" />,
    );
    await screen.findByText("testdb.users");
    fireEvent.click(screen.getByText("Indexes"));
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
    fireEvent.click(screen.getByText("DDL"));
    expect(screen.getByTestId("monaco-editor")).toBeDefined();
  });

  it("shows error on fetch failure", async () => {
    vi.mocked(api.getColumns).mockRejectedValue("Table not found");

    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="nonexistent" />,
    );
    expect(await screen.findByText("Table not found")).toBeDefined();
  });

  it("shows 'No columns found' when columns array is empty", async () => {
    vi.mocked(api.getColumns).mockResolvedValue([]);
    vi.mocked(api.getIndexes).mockResolvedValue([]);
    vi.mocked(api.getTableDdl).mockResolvedValue("");

    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="empty_table" />,
    );
    expect(await screen.findByText("No columns found.")).toBeDefined();
  });

  it("shows 'No indexes found' when indexes array is empty", async () => {
    vi.mocked(api.getIndexes).mockResolvedValue([]);
    render(
      <TableStructure connectionId="conn-1" database="testdb" tableName="users" />,
    );
    await screen.findByText("testdb.users");
    fireEvent.click(screen.getByText("Indexes"));
    expect(screen.getByText("No indexes found.")).toBeDefined();
  });
});
