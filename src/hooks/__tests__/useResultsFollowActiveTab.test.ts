import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";
import type { QueryResult } from "../../types";
import { useResultsFollowActiveTab } from "../useResultsFollowActiveTab";

const result = {
  query_id: "q1",
  statement_index: 0,
  sql: "SELECT * FROM orders",
  columns: [],
  rows: [["o"]],
  rows_affected: 0,
  execution_time_ms: 1,
  warnings: [],
} as unknown as QueryResult;

// #842: switching editor tabs swaps the results pane to that tab's results.
describe("useResultsFollowActiveTab", () => {
  it("shows the active tab's results and an empty pane for a new tab", () => {
    useEditorStore.setState({
      tabs: [{ id: "tab-a", title: "A", content: "", type: "query", isDirty: false }],
      activeTabId: "tab-a",
    });
    useResultStore.setState({ viewTabId: null, parked: {}, results: [] });
    renderHook(() => useResultsFollowActiveTab());
    act(() => useResultStore.setState({ results: [result] }));

    act(() => {
      useEditorStore.getState().addTab();
    });
    expect(useResultStore.getState().results).toEqual([]);

    act(() => useEditorStore.getState().setActiveTab("tab-a"));
    expect(useResultStore.getState().results).toEqual([result]);
  });
});
