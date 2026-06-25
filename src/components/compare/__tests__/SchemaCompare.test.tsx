import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SchemaCompare } from "../SchemaCompare";

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    getDatabases: vi.fn(),
    getTables: vi.fn(),
    getColumns: vi.fn(),
    getIndexes: vi.fn(),
    getViews: vi.fn(),
    getRoutines: vi.fn(),
    getTriggers: vi.fn(),
    getViewDdl: vi.fn(),
    getRoutineDdl: vi.fn(),
    getTriggerDdl: vi.fn(),
  },
}));

vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: vi.fn(),
}));

vi.mock("../../../lib/schema-diff", () => ({
  compareSchemas: vi.fn(),
  compareColumns: vi.fn(),
  compareIndexes: vi.fn(),
}));

vi.mock("../../../lib/sync-sql-generator", () => ({
  generateSyncSQL: vi.fn(),
}));

vi.mock("../SyncPreview", () => ({
  SyncPreview: ({ onBack, statements }: { onBack: () => void; statements: unknown[] }) => (
    <div data-testid="sync-preview">
      SyncPreview ({statements.length} statements)
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));

import { compareSchemas } from "../../../lib/schema-diff";
import { generateSyncSQL } from "../../../lib/sync-sql-generator";
import { api } from "../../../lib/tauri-api";
import { useConnectionStore } from "../../../stores/connectionStore";

describe("SchemaCompare", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useConnectionStore).mockImplementation((selector) => {
      const state = {
        activeConnections: [
          {
            id: "conn-1",
            name: "Production DB",
            host: "prod",
            port: 3306,
            server_version: "8.0",
            connected_at: "2024-01-01",
            profile_id: "p1",
          },
          {
            id: "conn-2",
            name: "Staging DB",
            host: "staging",
            port: 3306,
            server_version: "8.0",
            connected_at: "2024-01-01",
            profile_id: "p2",
          },
        ],
      };
      if (typeof selector === "function") return selector(state);
      return state;
    });
  });

  it("renders the schema compare interface", () => {
    render(<SchemaCompare />);
    expect(screen.getByText("Source")).toBeDefined();
    expect(screen.getByText("Target")).toBeDefined();
    expect(screen.getByText("Compare")).toBeDefined();
  });

  it("renders connection select dropdowns", () => {
    render(<SchemaCompare />);
    const selects = screen.getAllByRole("combobox");
    expect(selects.length).toBeGreaterThanOrEqual(2);
  });

  it("shows placeholder text when no comparison done", () => {
    render(<SchemaCompare />);
    expect(
      screen.getByText("Select source and target databases, then click Compare"),
    ).toBeDefined();
  });

  it("disable Compare button when connections not selected", () => {
    render(<SchemaCompare />);
    const btn = screen.getByText("Compare");
    expect(btn.closest("button")?.disabled).toBe(true);
  });

  it("loads databases when connection is selected", async () => {
    vi.mocked(api.getDatabases).mockResolvedValue([
      { name: "mydb", default_charset: "utf8mb4", default_collation: "utf8mb4_general_ci" },
    ]);

    render(<SchemaCompare />);
    // Select a connection in the source dropdown
    const sourceSelect = screen.getAllByRole("combobox")[0];
    fireEvent.change(sourceSelect, { target: { value: "conn-1" } });

    expect(api.getDatabases).toHaveBeenCalledWith("conn-1");
  });

  it("runs comparison and shows results", async () => {
    vi.mocked(api.getDatabases).mockResolvedValue([
      { name: "mydb", default_charset: "utf8mb4", default_collation: "utf8mb4_general_ci" },
    ]);
    vi.mocked(api.getTables).mockResolvedValue([
      { name: "users", table_type: "BASE TABLE", engine: "InnoDB", row_count: 100, data_size: 1024, comment: "" },
    ]);
    vi.mocked(api.getColumns).mockResolvedValue([
      {
        name: "id",
        data_type: "int",
        column_type: "INT",
        nullable: false,
        is_primary_key: true,
        default_value: undefined,
        extra: "",
        comment: "",
      },
    ]);
    vi.mocked(api.getIndexes).mockResolvedValue([
      { name: "PRIMARY", columns: ["id"], is_unique: true, index_type: "BTREE" },
    ]);
    vi.mocked(api.getViews).mockResolvedValue([]);
    vi.mocked(api.getRoutines).mockResolvedValue([]);
    vi.mocked(api.getTriggers).mockResolvedValue([]);

    const mockComparison = {
      tables: { onlyInSource: [], onlyInTarget: [], different: [], identical: ["users"] },
      views: { onlyInSource: [], onlyInTarget: [], different: [], identical: [] },
      routines: { onlyInSource: [], onlyInTarget: [], different: [], identical: [] },
      triggers: { onlyInSource: [], onlyInTarget: [], different: [], identical: [] },
    };
    vi.mocked(compareSchemas).mockReturnValue(mockComparison);
    vi.mocked(generateSyncSQL).mockReturnValue([]);

    render(<SchemaCompare />);

    // Select source connection and database
    const sourceSelects = screen.getAllByRole("combobox");
    fireEvent.change(sourceSelects[0], { target: { value: "conn-1" } });

    await act(async () => new Promise((r) => setTimeout(r, 50)));

    const allSelects = screen.getAllByRole("combobox");
    const dbSelect = allSelects[1];
    fireEvent.change(dbSelect, { target: { value: "mydb" } });

    // Same for target
    const targetConnSelect = allSelects[2];
    fireEvent.change(targetConnSelect, { target: { value: "conn-2" } });

    await act(async () => new Promise((r) => setTimeout(r, 50)));

    const allSelects2 = screen.getAllByRole("combobox");
    const dbSelect2 = allSelects2[3];
    fireEvent.change(dbSelect2, { target: { value: "mydb" } });

    await act(async () => {
      fireEvent.click(screen.getByText("Compare"));
    });

    expect(compareSchemas).toHaveBeenCalled();
  });

  it("shows error on comparison failure", async () => {
    vi.mocked(api.getDatabases).mockRejectedValue("Failed to load databases");
    render(<SchemaCompare />);

    const sourceSelect = screen.getAllByRole("combobox")[0];
    fireEvent.change(sourceSelect, { target: { value: "conn-1" } });

    expect(await screen.findByText(/Failed to load databases/)).toBeDefined();
  });
});
