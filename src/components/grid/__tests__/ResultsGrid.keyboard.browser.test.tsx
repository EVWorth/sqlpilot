import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "../../../types";
import { ResultsGrid } from "../ResultsGrid";

// The grid's keyboard path in a real browser, with the real virtualizer and
// real layout: the focused cell has to stay on screen as the arrows move it,
// across a virtualized result and past the right edge (#852). Only the stores
// and the backend are stand-ins.

const resultState = {
  results: [] as QueryResult[],
  activeResultIndex: 0,
  isExecuting: false,
  error: null as string | null,
  page: null,
  resultSource: { connectionId: "conn-1", database: "app" } as { connectionId: string; database?: string } | null,
};

vi.mock("../../../stores/resultStore", () => ({
  useResultStore: Object.assign(
    (selector?: (s: unknown) => unknown) => {
      const full = { ...resultState, setActiveResult: vi.fn(), executeQuery: vi.fn(), goToPage: vi.fn() };
      return selector ? selector(full) : full;
    },
    {
      getState: () => ({ ...resultState, setActiveResult: vi.fn(), executeQuery: vi.fn(), goToPage: vi.fn() }),
    },
  ),
}));

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: Object.assign(
    (selector?: (s: unknown) => unknown) => {
      const s = { tabs: [], activeTabId: null };
      return selector ? selector(s) : s;
    },
    { getState: () => ({ tabs: [], activeTabId: null }) },
  ),
}));

vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: Object.assign(
    (selector?: (s: unknown) => unknown) => {
      const s = { selectedConnectionId: "conn-1", activeConnections: [], profiles: [] };
      return selector ? selector(s) : s;
    },
    { getState: () => ({ selectedConnectionId: "conn-1", activeConnections: [], profiles: [] }) },
  ),
}));

vi.mock("../../../lib/run-statement", () => ({
  runGridEdits: vi.fn(async () => null),
  runStatement: vi.fn(async () => []),
}));

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    exportResults: vi.fn(),
    executeQuery: vi.fn(),
    getColumns: vi.fn(async () => []),
    getIndexes: vi.fn(async () => []),
  },
  CommandError: class CommandError extends Error {},
}));

/** A result `rows` long and `cols` wide, each cell naming its place. */
function makeResult(rows: number, cols: number): QueryResult {
  return {
    query_id: "q1",
    statement_index: 0,
    columns: Array.from({ length: cols }, (_, c) => ({
      name: `col_${c}`,
      data_type: "varchar",
      nullable: true,
      is_primary_key: false,
    })),
    rows: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => `r${r}c${c}`)),
    rows_affected: 0,
    execution_time_ms: 1,
    warnings: [],
    rows_truncated: false,
    sql: "SELECT * FROM wide",
  } as unknown as QueryResult;
}

function Frame() {
  return (
    <div style={{ width: 600, height: 400, display: "flex", flexDirection: "column" }}>
      <ResultsGrid />
    </div>
  );
}

const grid = () => screen.getByLabelText("Query results");

function focusedCell(): HTMLElement {
  const cell = document.querySelector<HTMLElement>("[data-focused-cell]");
  if (!cell) throw new Error("no focused cell");
  return cell;
}

/** Whether the focused cell lies wholly inside the scrolling area, below its sticky header. */
function focusedCellIsVisible(): boolean {
  const cell = focusedCell().getBoundingClientRect();
  const scroller = grid().querySelector<HTMLElement>(".overflow-auto");
  if (!scroller) throw new Error("no scroller");
  const box = scroller.getBoundingClientRect();
  const header = scroller.querySelector<HTMLElement>("[data-grid-header]");
  const headerBottom = header ? header.getBoundingClientRect().bottom : box.top;
  return cell.top >= headerBottom - 1
    && cell.bottom <= box.bottom + 1
    && cell.left >= box.left - 1
    && cell.right <= box.right + 1;
}

describe("the focused cell stays in view (#852)", () => {
  afterEach(() => {
    resultState.results = [];
  });

  it("follows Ctrl+End and Ctrl+Home across a virtualized result", async () => {
    resultState.results = [makeResult(6000, 12)];
    render(<Frame />);
    grid().focus();

    await userEvent.keyboard("{Control>}{End}{/Control}");
    await waitFor(() => expect(focusedCell().textContent).toContain("r5999c11"));
    await waitFor(() => expect(focusedCellIsVisible()).toBe(true));

    await userEvent.keyboard("{Control>}{Home}{/Control}");
    await waitFor(() => expect(focusedCell().textContent).toContain("r0c0"));
    await waitFor(() => expect(focusedCellIsVisible()).toBe(true));
  });

  it("scrolls a virtualized result as the arrows run off the bottom and the right", async () => {
    resultState.results = [makeResult(6000, 12)];
    render(<Frame />);
    grid().focus();

    await userEvent.keyboard("{ArrowDown}");
    for (let i = 0; i < 30; i++) await userEvent.keyboard("{ArrowDown}");
    for (let i = 0; i < 8; i++) await userEvent.keyboard("{ArrowRight}");

    await waitFor(() => expect(focusedCell().textContent).toContain("r30c8"));
    await waitFor(() => expect(focusedCellIsVisible()).toBe(true));
  });

  it("keeps the cell clear of the sticky header in the table layout", async () => {
    resultState.results = [makeResult(200, 12)];
    render(<Frame />);
    grid().focus();

    await userEvent.keyboard("{Control>}{End}{/Control}");
    await waitFor(() => expect(focusedCell().textContent).toContain("r199c11"));
    await waitFor(() => expect(focusedCellIsVisible()).toBe(true));

    // Back up past the top of the viewport: the row must come out from
    // under the header, not stop behind it.
    for (let i = 0; i < 40; i++) await userEvent.keyboard("{ArrowUp}");
    await userEvent.keyboard("{Home}");
    await waitFor(() => expect(focusedCell().textContent).toContain("r159c0"));
    await waitFor(() => expect(focusedCellIsVisible()).toBe(true));
  });
});
