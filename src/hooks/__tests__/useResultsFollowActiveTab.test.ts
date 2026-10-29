import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { resetRunBookkeeping, useResultStore } from "../../stores/resultStore";
import type { ConnectionInfo, EditorTab, QueryResult } from "../../types";
import { useResultsFollowActiveTab } from "../useResultsFollowActiveTab";

const result = {
  query_id: "q1",
  statement_index: 0,
  sql: "SELECT * FROM customers",
  columns: [],
  rows: [["c"]],
  rows_affected: 0,
  execution_time_ms: 1,
  warnings: [],
} as unknown as QueryResult;

const connection = (id: string) => ({ id, name: id, profile_id: id }) as unknown as ConnectionInfo;

const tab = (id: string, connectionId?: string): EditorTab => ({
  id,
  title: id,
  content: "",
  type: "query",
  isDirty: false,
  connectionId,
});

// #842: a grid read on one server is not shown under another.
describe("useResultsFollowActiveTab", () => {
  beforeEach(() => {
    resetRunBookkeeping();
    useConnectionStore.setState({
      activeConnections: [connection("dev"), connection("prod")],
      selectedConnectionId: "dev",
    });
    useResultStore.setState({ viewTabId: null, runTabId: null, parked: {}, results: [], resultSource: null });
  });

  it("keeps a tab's results when another server is selected but the tab has its own", () => {
    useEditorStore.setState({ tabs: [tab("bound-a", "dev")], activeTabId: "bound-a" });
    useResultStore.setState({ results: [result], resultSource: { connectionId: "dev" } });
    renderHook(() => useResultsFollowActiveTab());

    act(() => useConnectionStore.setState({ selectedConnectionId: "prod" }));

    expect(useResultStore.getState().results).toEqual([result]);
  });

  it("clears the shown tab's results when its connection changes", () => {
    useEditorStore.setState({ tabs: [tab("free-a")], activeTabId: "free-a" });
    useResultStore.setState({ results: [result], resultSource: { connectionId: "dev" } });
    renderHook(() => useResultsFollowActiveTab());

    // Connecting a second server selects it, and an unbound tab runs there.
    act(() => useConnectionStore.setState({ selectedConnectionId: "prod" }));

    expect(useResultStore.getState().results).toEqual([]);
    expect(useResultStore.getState().resultSource).toBeNull();
  });

  it("clears a parked tab's results read elsewhere when it is shown again", () => {
    useEditorStore.setState({ tabs: [tab("bound-b", "dev"), tab("free-b")], activeTabId: "free-b" });
    useResultStore.setState({ results: [result], resultSource: { connectionId: "dev" } });
    renderHook(() => useResultsFollowActiveTab());

    act(() => useEditorStore.getState().setActiveTab("bound-b"));
    act(() => useConnectionStore.setState({ selectedConnectionId: "prod" }));
    act(() => useEditorStore.getState().setActiveTab("free-b"));

    expect(useResultStore.getState().results).toEqual([]);
  });
});
