import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { AdminPanel } from "../AdminPanel";

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    getProcessList: vi.fn(),
    killProcess: vi.fn(),
    executeQuery: vi.fn(),
    getServerVariables: vi.fn(),
  },
}));

vi.mock("../UserManagement", () => ({
  UserManagement: ({ connectionId }: { connectionId: string }) => (
    <div data-testid="user-management">UserManagement: {connectionId}</div>
  ),
}));

import { api } from "../../../lib/tauri-api";

describe("AdminPanel", () => {
  const mockConnectionId = "conn-test-1";

  beforeEach(() => {
    vi.clearAllMocks();
    // Provide default resolved values so tabs don't crash on mount
    vi.mocked(api.getProcessList).mockResolvedValue([]);
    vi.mocked(api.getServerVariables).mockResolvedValue([]);
    vi.mocked(api.executeQuery).mockResolvedValue([]);
  });

  it("renders sub-tabs: Process List, Server Variables, Server Status, Users", async () => {
    render(<AdminPanel connectionId={mockConnectionId} />);
    expect(screen.getByText("Process List")).toBeDefined();
    expect(screen.getByText("Server Variables")).toBeDefined();
    expect(screen.getByText("Server Status")).toBeDefined();
    expect(screen.getByText("Users")).toBeDefined();
  });

  it("shows ProcessListTab by default", async () => {
    render(<AdminPanel connectionId={mockConnectionId} />);
    expect(await screen.findByPlaceholderText("Filter processes…")).toBeDefined();
  });

  it("switches to Server Variables tab", async () => {
    render(<AdminPanel connectionId={mockConnectionId} />);

    fireEvent.click(screen.getByText("Server Variables"));
    expect(await screen.findByPlaceholderText("Filter variables…")).toBeDefined();
  });

  it("switches to Server Status tab", async () => {
    render(<AdminPanel connectionId={mockConnectionId} />);

    fireEvent.click(screen.getByText("Server Status"));
    expect(await screen.findByPlaceholderText("Filter status variables…")).toBeDefined();
  });

  it("switches to Users tab and renders UserManagement", () => {
    render(<AdminPanel connectionId={mockConnectionId} />);
    fireEvent.click(screen.getByText("Users"));
    expect(screen.getByTestId("user-management")).toBeDefined();
  });
});

describe("ProcessListTab", () => {
  const mockConnectionId = "conn-test-1";

  const mockProcesses = [
    { id: 1, user: "root", host: "localhost", db: "test", command: "Query", time: 1, state: "executing", info: "SELECT 1" },
    { id: 2, user: "app", host: "10.0.0.1", db: null, command: "Sleep", time: 60, state: null, info: null },
    { id: 3, user: "admin", host: "localhost", db: "mydb", command: "Query", time: 120, state: "Sending data", info: "SELECT * FROM big_table" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getProcessList).mockResolvedValue(mockProcesses);
    vi.mocked(api.killProcess).mockResolvedValue(undefined);
  });

  it("shows loading state initially", async () => {
    vi.mocked(api.getProcessList).mockReturnValue(new Promise(() => {}));
    render(<AdminPanel connectionId={mockConnectionId} />);
    expect(screen.getByText("Loading processes…")).toBeDefined();
  });

  it("renders process list after loading", async () => {
    render(<AdminPanel connectionId={mockConnectionId} />);
    expect(await screen.findByText("root")).toBeDefined();
    expect(screen.getByText("app")).toBeDefined();
    expect(screen.getByText("admin")).toBeDefined();
  });

  it("displays error on fetch failure", async () => {
    vi.mocked(api.getProcessList).mockRejectedValue("Fetch error");
    render(<AdminPanel connectionId={mockConnectionId} />);
    expect(await screen.findByText("Fetch error")).toBeDefined();
  });

  it("filters processes by search input", async () => {
    render(<AdminPanel connectionId={mockConnectionId} />);
    await screen.findByText("root");
    const filterInput = screen.getByPlaceholderText("Filter processes…");
    fireEvent.change(filterInput, { target: { value: "app" } });
    expect(screen.queryByText("root")).toBeNull();
    expect(screen.getByText("app")).toBeDefined();
  });

  it("shows 'No processes match the filter' when filter yields no results", async () => {
    render(<AdminPanel connectionId={mockConnectionId} />);
    await screen.findByText("root");
    const filterInput = screen.getByPlaceholderText("Filter processes…");
    fireEvent.change(filterInput, { target: { value: "nonexistent" } });
    expect(screen.getByText("No processes match the filter")).toBeDefined();
  });

  it("shows confirm kill on skull button click", async () => {
    render(<AdminPanel connectionId={mockConnectionId} />);
    await screen.findByText("root");
    const skullButtons = screen.getAllByTitle(/Kill process/);
    fireEvent.click(skullButtons[0]);
    expect(screen.getByText("Kill?")).toBeDefined();
    expect(screen.getByText("Cancel")).toBeDefined();
  });

  it("calls killProcess and refreshes on confirm", async () => {
    render(<AdminPanel connectionId={mockConnectionId} />);
    await screen.findByText("root");
    const skullButtons = screen.getAllByTitle(/Kill process/);
    fireEvent.click(skullButtons[0]);
    fireEvent.click(screen.getByText("Kill?"));
    expect(api.killProcess).toHaveBeenCalledWith(mockConnectionId, 1);
  });

  it("shows error on kill failure", async () => {
    vi.mocked(api.killProcess).mockRejectedValue("Kill failed");
    render(<AdminPanel connectionId={mockConnectionId} />);
    await screen.findByText("root");
    const skullButtons = screen.getAllByTitle(/Kill process/);
    fireEvent.click(skullButtons[0]);
    await act(async () => {
      fireEvent.click(screen.getByText("Kill?"));
    });
    expect(await screen.findByText(/Failed to kill process/)).toBeDefined();
  });
});

describe("ServerVariablesTab", () => {
  const mockConnectionId = "conn-test-1";

  const mockVariables = [
    { name: "version", value: "8.0.35" },
    { name: "max_connections", value: "151" },
    { name: "innodb_buffer_pool_size", value: "134217728" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getServerVariables).mockResolvedValue(mockVariables);
  });

  it("renders variable groups after loading", async () => {
    render(<AdminPanel connectionId={mockConnectionId} />);
    fireEvent.click(screen.getByText("Server Variables"));
    expect(await screen.findByText("version")).toBeDefined();
    expect(screen.getByText("8.0.35")).toBeDefined();
  });

  it("shows error on fetch failure", async () => {
    vi.mocked(api.getServerVariables).mockRejectedValue("Var fetch error");
    render(<AdminPanel connectionId={mockConnectionId} />);
    fireEvent.click(screen.getByText("Server Variables"));
    expect(await screen.findByText("Var fetch error")).toBeDefined();
  });

  it("filters variables by search", async () => {
    render(<AdminPanel connectionId={mockConnectionId} />);
    fireEvent.click(screen.getByText("Server Variables"));
    await screen.findByText("version");
    const filterInput = screen.getByPlaceholderText("Filter variables…");
    fireEvent.change(filterInput, { target: { value: "version" } });
    expect(screen.getByText("version")).toBeDefined();
    expect(screen.queryByText("max_connections")).toBeNull();
  });
});

describe("ServerStatusTab", () => {
  const mockConnectionId = "conn-test-1";

  const mockStatusResults = [
    {
      query_id: "q1",
      statement_index: 0,
      columns: [{ name: "Variable_name", data_type: "VARCHAR", nullable: false, is_primary_key: false }, { name: "Value", data_type: "VARCHAR", nullable: false, is_primary_key: false }],
      rows: [
        ["Uptime", "3600"],
        ["Queries", "1000"],
        ["Slow_queries", "5"],
        ["Connections", "200"],
        ["Threads_connected", "10"],
        ["Threads_running", "2"],
        ["Threads_cached", "5"],
      ],
      rows_affected: 0,
      execution_time_ms: 10,
      warnings: [],
      rows_truncated: false,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.executeQuery).mockResolvedValue(mockStatusResults);
  });

  it("renders metric cards after loading", async () => {
    render(<AdminPanel connectionId={mockConnectionId} />);
    fireEvent.click(screen.getByText("Server Status"));
    expect((await screen.findAllByText("Uptime")).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryAllByText("Connections").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryAllByText("QPS").length).toBeGreaterThanOrEqual(1);
  });

  it("shows error on fetch failure", async () => {
    vi.mocked(api.executeQuery).mockRejectedValue("Status error");
    render(<AdminPanel connectionId={mockConnectionId} />);
    fireEvent.click(screen.getByText("Server Status"));
    expect(await screen.findByText("Status error")).toBeDefined();
  });
});
