import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBar } from "../StatusBar";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useResultStore } from "../../../stores/resultStore";
import { useEditorStore } from "../../../stores/editorStore";

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    getAppVersion: vi.fn().mockResolvedValue("2.1.0"),
  },
}));

Object.defineProperty(navigator, "clipboard", {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  writable: true,
});

describe("StatusBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    useConnectionStore.setState({
      activeConnections: [
        {
          id: "conn-1",
          profile_id: "prof-1",
          name: "Production DB",
          host: "db.example.com",
          port: 3306,
          database: "analytics",
          server_version: "8.0.33",
          connected_at: "2024-01-01T00:00:00Z",
        },
      ],
      selectedConnectionId: "conn-1",
      error: null,
      profiles: [
        {
          id: "prof-1",
          name: "Prod Profile",
          environment: "production" as const,
        },
      ],
      loading: false,
    } as any);

    useResultStore.setState({
      isExecuting: false,
      results: [],
      activeResultIndex: 0,
      error: null,
    } as any);

    useEditorStore.setState({
      tabs: [
        { id: "tab-0", title: "Query", content: "", type: "query", isDirty: false, database: "analytics" },
      ],
      activeTabId: "tab-0",
      editorInstance: null,
    });
  });

  it("renders connection name and host:port", () => {
    render(<StatusBar />);

    expect(screen.getByText(/Production DB/)).toBeInTheDocument();
    expect(screen.getByText(/db\.example\.com:3306/)).toBeInTheDocument();
  });

  it("renders MySQL version", () => {
    render(<StatusBar />);
    expect(screen.getByText("MySQL 8.0.33")).toBeInTheDocument();
  });

  it("renders 'Disconnected' when no connection is active", () => {
    useConnectionStore.setState({
      activeConnections: [],
      selectedConnectionId: null,
      error: null,
      profiles: [],
      loading: false,
    } as any);

    render(<StatusBar />);
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
  });

  it("renders environment badge for production", () => {
    render(<StatusBar />);
    expect(screen.getByText("PROD")).toBeInTheDocument();
  });

  it("renders database name", () => {
    render(<StatusBar />);
    expect(screen.getByText("analytics")).toBeInTheDocument();
  });

  it("renders executing indicator when query is running", () => {
    useResultStore.setState({
      isExecuting: true,
      results: [],
      activeResultIndex: 0,
      error: null,
    } as any);

    render(<StatusBar />);
    expect(screen.getByText("Executing...")).toBeInTheDocument();
  });

  it("renders error when present", () => {
    useResultStore.setState({
      isExecuting: false,
      results: [],
      activeResultIndex: 0,
      error: "Syntax error near 'SELEKT'",
    } as any);

    render(<StatusBar />);
    expect(screen.getByText(/Syntax error/)).toBeInTheDocument();
  });

  it("renders connection error when present", () => {
    useConnectionStore.setState({
      activeConnections: [
        {
          id: "conn-1",
          profile_id: "prof-1",
          name: "Test DB",
          host: "localhost",
          port: 3306,
          server_version: "8.0.33",
          connected_at: "2024-01-01T00:00:00Z",
        },
      ],
      selectedConnectionId: "conn-1",
      error: "Connection timed out",
      profiles: [],
      loading: false,
    } as any);

    render(<StatusBar />);
    expect(screen.getByText("Connection timed out")).toBeInTheDocument();
  });

  it("renders result stats when results exist", () => {
    useResultStore.setState({
      isExecuting: false,
      results: [
        {
          query_id: "q-1",
          statement_index: 0,
          columns: [{ name: "id", data_type: "int", nullable: false, is_primary_key: true }],
          rows: [[1], [2], [3]],
          rows_affected: 0,
          execution_time_ms: 150,
          warnings: [],
          rows_truncated: false,
        },
      ],
      activeResultIndex: 0,
      error: null,
    } as any);

    render(<StatusBar />);
    expect(screen.getByText(/3 rows/)).toBeInTheDocument();
    expect(screen.getByText(/150ms/)).toBeInTheDocument();
  });

  it("shows app version after mount", async () => {
    render(<StatusBar />);
    expect(await screen.findByText("v2.1.0")).toBeInTheDocument();
  });
});
