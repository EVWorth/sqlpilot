import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useQueryExecution } from "../useQueryExecution";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";

// Mock the Tauri API so store actions that call invoke don't fail
vi.mock("../../lib/tauri-api", () => ({
  api: {
    executeQuery: vi.fn().mockResolvedValue([]),
  },
}));

const mockExecuteQuery = vi.fn().mockResolvedValue(undefined);
const mockExecuteExplain = vi.fn().mockResolvedValue(undefined);
const mockExecuteExplainAnalyze = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();

  // Reset stores to clean state
  useConnectionStore.setState({
    selectedConnectionId: null,
    activeConnections: [],
    profiles: [],
  } as unknown as Parameters<typeof useConnectionStore.setState>[0]);

  useEditorStore.setState({ tabs: [], activeTabId: null });

  useResultStore.setState({
    isExecuting: false,
    error: null,
    results: [],
    executeQuery: mockExecuteQuery,
    executeExplain: mockExecuteExplain,
    executeExplainAnalyze: mockExecuteExplainAnalyze,
  } as unknown as Parameters<typeof useResultStore.setState>[0]);
});

describe("useQueryExecution", () => {
  it("canExecute is false when no connection is selected", () => {
    const { result } = renderHook(() => useQueryExecution());
    expect(result.current.canExecute).toBe(false);
  });

  it("canExecute is false when a query is executing", () => {
    useConnectionStore.setState({ selectedConnectionId: "conn-1" } as Parameters<typeof useConnectionStore.setState>[0]);
    useResultStore.setState({ isExecuting: true } as Parameters<typeof useResultStore.setState>[0]);
    const { result } = renderHook(() => useQueryExecution());
    expect(result.current.canExecute).toBe(false);
  });

  it("canExecute is true when connection is set and not executing", () => {
    useConnectionStore.setState({ selectedConnectionId: "conn-1" } as Parameters<typeof useConnectionStore.setState>[0]);
    const { result } = renderHook(() => useQueryExecution());
    expect(result.current.canExecute).toBe(true);
  });

  it("exposes the selected connectionId and active tab database", () => {
    useConnectionStore.setState({ selectedConnectionId: "conn-1" } as Parameters<typeof useConnectionStore.setState>[0]);
    const tabId = useEditorStore.getState().addTab("conn-1", "my_db");
    useEditorStore.getState().setTabConnection(tabId, "conn-1", "my_db");

    const { result } = renderHook(() => useQueryExecution());
    expect(result.current.connectionId).toBe("conn-1");
    expect(result.current.database).toBe("my_db");
  });

  it("executeQuery passes connectionId and database from active tab to the store action", async () => {
    useConnectionStore.setState({ selectedConnectionId: "conn-1" } as Parameters<typeof useConnectionStore.setState>[0]);
    const tabId = useEditorStore.getState().addTab("conn-1", "my_db");
    useEditorStore.getState().setTabConnection(tabId, "conn-1", "my_db");

    const { result } = renderHook(() => useQueryExecution());
    await act(() => result.current.executeQuery("SELECT 1"));

    expect(mockExecuteQuery).toHaveBeenCalledWith("conn-1", "SELECT 1", "my_db");
  });

  it("executeQuery uses undefined database when no tab database is set", async () => {
    useConnectionStore.setState({ selectedConnectionId: "conn-1" } as Parameters<typeof useConnectionStore.setState>[0]);
    useEditorStore.getState().addTab("conn-1");

    const { result } = renderHook(() => useQueryExecution());
    await act(() => result.current.executeQuery("SELECT 1"));

    expect(mockExecuteQuery).toHaveBeenCalledWith("conn-1", "SELECT 1", undefined);
  });

  it("executeQuery does nothing when no connection is selected", async () => {
    const { result } = renderHook(() => useQueryExecution());
    await act(() => result.current.executeQuery("SELECT 1"));
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  it("executeExplain passes connectionId and database from active tab", async () => {
    useConnectionStore.setState({ selectedConnectionId: "conn-2" } as Parameters<typeof useConnectionStore.setState>[0]);
    const tabId = useEditorStore.getState().addTab("conn-2", "schema_x");
    useEditorStore.getState().setTabConnection(tabId, "conn-2", "schema_x");

    const { result } = renderHook(() => useQueryExecution());
    await act(() => result.current.executeExplain("SELECT * FROM t"));

    expect(mockExecuteExplain).toHaveBeenCalledWith("conn-2", "SELECT * FROM t", "schema_x");
  });

  it("executeExplainAnalyze passes connectionId and database from active tab", async () => {
    useConnectionStore.setState({ selectedConnectionId: "conn-3" } as Parameters<typeof useConnectionStore.setState>[0]);
    const tabId = useEditorStore.getState().addTab("conn-3", "db_y");
    useEditorStore.getState().setTabConnection(tabId, "conn-3", "db_y");

    const { result } = renderHook(() => useQueryExecution());
    await act(() => result.current.executeExplainAnalyze("SELECT * FROM t"));

    expect(mockExecuteExplainAnalyze).toHaveBeenCalledWith("conn-3", "SELECT * FROM t", "db_y");
  });

  it("database reflects the active tab after setTabConnection", () => {
    useConnectionStore.setState({ selectedConnectionId: "conn-1" } as Parameters<typeof useConnectionStore.setState>[0]);
    const tabId = useEditorStore.getState().addTab("conn-1");

    const { result, rerender } = renderHook(() => useQueryExecution());
    expect(result.current.database).toBeUndefined();

    act(() => {
      useEditorStore.getState().setTabConnection(tabId, "conn-1", "new_db");
    });
    rerender();

    expect(result.current.database).toBe("new_db");
  });
});
