import { install } from "@/dev/mock/__tests__/helpers";
import { storeResult } from "@/dev/mock/handlers/results";
import type { QueryResult_Serialize } from "@/lib/bindings";
import { fromHandle } from "@/lib/stored-result";
import { useResultStore } from "@/stores/resultStore";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResultsGrid } from "../ResultsGrid";

/**
 * The real grid over a result the backend's store keeps
 * (docs/design/RESULT_STORE.md), with the mock backend standing in for it.
 * In a real browser, because what is on screen decides what is read.
 */

const ROWS = 10_000;

function storedResult() {
  const result: QueryResult_Serialize = {
    query_id: "q",
    statement_index: 0,
    sql: "SELECT id, name FROM t",
    columns: [
      { name: "id", data_type: "INT", nullable: false, is_primary_key: true },
      { name: "name", data_type: "VARCHAR", nullable: true, is_primary_key: false },
    ],
    rows: Array.from({ length: ROWS }, (_, i) => [i + 1, `name-${String(i + 1).padStart(5, "0")}`]),
    rows_affected: ROWS,
    execution_time_ms: 3,
    warnings: [],
    rows_truncated: false,
  };
  return fromHandle(storeResult(result));
}

const scroller = () => document.querySelector<HTMLElement>(".overflow-auto")!;
const placeholders = () => document.querySelectorAll("[data-row-placeholder]");

beforeEach(() => {
  install("?mock");
  useResultStore.setState({ results: [storedResult()], activeResultIndex: 0, isExecuting: false, error: null });
});

afterEach(() => {
  useResultStore.setState({ results: [] });
  vi.restoreAllMocks();
});

describe("a stored result in the grid", () => {
  it("paints the first rows, and loads the rows scrolled to", async () => {
    render(
      <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
        <ResultsGrid />
      </div>,
    );
    expect(await screen.findByText("name-00001")).toBeInTheDocument();

    act(() => {
      scroller().scrollTop = scroller().scrollHeight;
      scroller().dispatchEvent(new Event("scroll"));
    });
    // The last row is read from the store and replaces its placeholder.
    expect(await screen.findByText("name-10000")).toBeInTheDocument();
    await waitFor(() => expect(placeholders().length).toBe(0));
  });

  it("sorts in the backend: the last row comes first descending", async () => {
    render(
      <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
        <ResultsGrid />
      </div>,
    );
    await screen.findByText("name-00001");
    const header = screen.getAllByText("name")[0];
    fireEvent.click(header);
    fireEvent.click(header);
    expect(await screen.findByText("name-10000")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("name-00001")).toBeNull());
  });
});
