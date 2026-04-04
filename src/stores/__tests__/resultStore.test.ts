import { describe, it, expect, beforeEach } from "vitest";
import { useResultStore } from "../resultStore";

describe("resultStore", () => {
  beforeEach(() => {
    useResultStore.setState({
      results: [],
      activeResultIndex: 0,
      isExecuting: false,
      error: null,
    });
  });

  it("should clear results", () => {
    useResultStore.setState({
      results: [
        {
          query_id: "1",
          statement_index: 0,
          columns: [],
          rows: [],
          rows_affected: 0,
          execution_time_ms: 10,
          warnings: [],
        },
      ],
    });
    useResultStore.getState().clearResults();
    expect(useResultStore.getState().results).toHaveLength(0);
  });

  it("should set active result index", () => {
    useResultStore.getState().setActiveResult(2);
    expect(useResultStore.getState().activeResultIndex).toBe(2);
  });

  it("should clear error", () => {
    useResultStore.setState({ error: "some error" });
    useResultStore.getState().clearError();
    expect(useResultStore.getState().error).toBeNull();
  });
});
