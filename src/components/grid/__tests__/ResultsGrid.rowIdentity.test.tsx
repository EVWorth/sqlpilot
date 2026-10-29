import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layoutKey } from "../../../lib/grid-layout";
import { runStatement } from "../../../lib/run-statement";
import { api } from "../../../lib/tauri-api";
import type { QueryResult } from "../../../types";
import { ResultsGrid } from "../ResultsGrid";

// The grid with its real editing state, context menu and SQL generator, so a
// row picked on screen can be followed all the way to the statement it
// produces. Only the stores and the backend are stand-ins.

const resultState = {
  results: [] as QueryResult[],
  activeResultIndex: 0,
  isExecuting: false,
  error: null as string | null,
  page: null,
  resultSource: null as { connectionId: string; database?: string; session?: string } | null,
};
const executeQuery = vi.fn();

vi.mock("../../../stores/resultStore", () => ({
  useResultStore: Object.assign(
    (selector?: (s: unknown) => unknown) => {
      const full = { ...resultState, setActiveResult: vi.fn(), executeQuery, goToPage: vi.fn() };
      return selector ? selector(full) : full;
    },
    {
      getState: () => ({ ...resultState, setActiveResult: vi.fn(), executeQuery, goToPage: vi.fn() }),
    },
  ),
}));

let editorTabs: { id: string; content: string; connectionId?: string; database?: string }[] = [];

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: Object.assign(
    (selector?: (s: unknown) => unknown) => {
      const s = { tabs: editorTabs, activeTabId: "tab-1" };
      return selector ? selector(s) : s;
    },
    { getState: () => ({ tabs: editorTabs, activeTabId: "tab-1" }) },
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

vi.mock("../../../stores/productionGuardStore", () => ({
  confirmDestructive: vi.fn(async () => true),
}));

vi.mock("../../../lib/run-statement", () => ({
  runGridEdits: vi.fn(async () => null),
  runStatement: vi.fn(async () => [{ rows_affected: 1 }]),
}));

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    exportResults: vi.fn(),
    executeQuery: vi.fn(),
    getColumns: vi.fn(async () => [
      { name: "id", data_type: "int", nullable: false, is_primary_key: true },
      { name: "name", data_type: "varchar", nullable: false, is_primary_key: false },
    ]),
    getIndexes: vi.fn(async () => []),
  },
  CommandError: class CommandError extends Error {},
}));

// jsdom has no layout, so the real virtualizer shows nothing. This one shows
// the first rows, which is all a test of the virtualized layout needs; the
// table layout, used below 5000 rows, never asks it.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 10) }, (_, index) => ({ index, start: index * 32, size: 32 })),
  }),
}));

function makeResult(): QueryResult {
  return {
    columns: [
      { name: "id", data_type: "int", nullable: false, is_primary_key: false },
      { name: "name", data_type: "varchar", nullable: false, is_primary_key: false },
    ],
    // Sorted by name, the order on screen is 2 (ada), 3 (bob), 1 (cy).
    rows: [[1, "cy"], [2, "ada"], [3, "bob"]],
    rows_affected: 0,
    execution_time_ms: 1,
    sql: "SELECT * FROM users",
  } as unknown as QueryResult;
}

const bodyRows = () => [...document.querySelectorAll("tbody tr")] as HTMLElement[];
const rowNames = () => bodyRows().map((tr) => tr.querySelectorAll("td")[2]?.textContent?.trim());

async function sortByName() {
  fireEvent.click(screen.getAllByText("name")[0]);
  await waitFor(() => expect(rowNames()).toEqual(["ada", "bob", "cy"]));
}

function rightClick(row: HTMLElement, colIdx = 1) {
  fireEvent.contextMenu(row.querySelectorAll("td")[colIdx]);
}

function menuItem(label: RegExp) {
  return within(document.body).getByRole("menuitem", { name: label });
}

// TruncatedCell measures itself; jsdom has no layout to measure.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

beforeEach(() => {
  resultState.results = [makeResult()];
  resultState.resultSource = { connectionId: "conn-1", database: "app" };
  editorTabs = [{ id: "tab-1", content: "SELECT * FROM users", connectionId: "conn-1", database: "app" }];
  vi.mocked(runStatement).mockClear();
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("after a sort, the row acted on is the row clicked (#839)", () => {
  it("copies the clicked row's cell", async () => {
    render(<ResultsGrid />);
    await sortByName();

    // Third on screen is id 1 ("cy"), which is first in the result.
    rightClick(bodyRows()[1], 2);
    fireEvent.click(menuItem(/^Copy Cell$/));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("bob");
  });

  it("deletes the clicked row, not the one at its old position", async () => {
    render(<ResultsGrid />);
    fireEvent.click(screen.getByRole("button", { name: /edit mode/i }));
    await sortByName();

    // "bob" (id 3) is second on screen and third in the result.
    rightClick(bodyRows()[1]);
    fireEvent.click(menuItem(/Delete Row/));

    // The strike-through lands on the row that was clicked.
    expect(bodyRows()[1].className).toContain("line-through");
    expect(bodyRows()[0].className).not.toContain("line-through");

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(runStatement).toHaveBeenCalled());
    const sql = vi.mocked(runStatement).mock.calls[0][0].sql;
    expect(sql).toContain("DELETE FROM `users` WHERE `id` = 3 LIMIT 1;");
  });

  it("selects the clicked row and extends Shift ranges over the screen order", async () => {
    render(<ResultsGrid />);
    await sortByName();

    fireEvent.click(bodyRows()[0]);
    fireEvent.click(bodyRows()[1], { shiftKey: true });

    const selected = bodyRows().map((tr) => tr.getAttribute("aria-selected"));
    expect(selected).toEqual(["true", "true", "false"]);
  });
});

describe("cells keep their DOM node across a row click (#841)", () => {
  it("survives the first click of a double-click outside edit mode", () => {
    render(<ResultsGrid />);
    const cell = screen.getByText("ada");

    fireEvent.click(bodyRows()[1]);

    expect(bodyRows()[1].getAttribute("aria-selected")).toBe("true");
    expect(cell.isConnected).toBe(true);
  });

  it("opens the editor on a double-click in edit mode", () => {
    render(<ResultsGrid />);
    fireEvent.click(screen.getByRole("button", { name: /edit mode/i }));
    const cell = screen.getByText("ada");

    // The first click selects the row and re-renders the grid; the second
    // must land on the same element for the browser to fire dblclick.
    fireEvent.click(cell);
    expect(cell.isConnected).toBe(true);
    fireEvent.doubleClick(cell);

    expect(screen.getByDisplayValue("ada")).toBeDefined();
  });
});

describe("the row key comes from where the result was read (#857)", () => {
  it("looks the key up on the result's connection, not the tab's current one", async () => {
    // The tab was pointed at another server after the query ran there.
    editorTabs = [{ id: "tab-1", content: "SELECT * FROM users", connectionId: "conn-2", database: "other" }];
    render(<ResultsGrid />);

    await waitFor(() => expect(api.getColumns).toHaveBeenCalled());
    expect(vi.mocked(api.getColumns).mock.calls.every(([conn, db]) => conn === "conn-1" && db === "app")).toBe(true);
  });

  it("keys the column layout by the result's connection and database", async () => {
    editorTabs = [{ id: "tab-1", content: "SELECT * FROM users", connectionId: "conn-2", database: "other" }];
    localStorage.setItem(
      layoutKey("conn-1", "app", ["id", "name"]) ?? "",
      JSON.stringify({ columnOrder: ["name", "id"] }),
    );
    render(<ResultsGrid />);

    await waitFor(() =>
      expect([...document.querySelectorAll("thead th")].slice(1).map((th) => th.textContent?.trim())).toEqual([
        "namevarchar",
        "idint",
      ])
    );
    localStorage.clear();
  });

  it("refuses Edit Mode when the result's source is unknown", () => {
    resultState.resultSource = null;
    render(<ResultsGrid />);

    const toggle = screen.getByRole("button", { name: /edit mode/i });
    expect(toggle).toBeDisabled();
    expect(toggle.getAttribute("title")).toMatch(/unknown/);
    expect(api.getColumns).not.toHaveBeenCalled();
  });
});

describe("a sorted grid acts in screen order (#858)", () => {
  it("moves Tab to the next row on screen, not the next in the result", async () => {
    render(<ResultsGrid />);
    fireEvent.click(screen.getByRole("button", { name: /edit mode/i }));
    await sortByName();

    // "bob" (id 3) is last in the result but second on screen, so Tab from
    // its last column has a next row on screen ("cy", id 1) and none in the
    // result.
    fireEvent.doubleClick(screen.getByText("bob"));
    fireEvent.keyDown(screen.getByDisplayValue("bob"), { key: "Tab" });

    // The editor opens on the first column of "cy": id 1.
    expect(screen.getByDisplayValue("1")).toBeDefined();
  });

  it("copies selected rows in the order they appear", async () => {
    render(<ResultsGrid />);
    await sortByName();

    // Select all three on screen: ada (2), bob (3), cy (1).
    fireEvent.click(bodyRows()[0]);
    fireEvent.click(bodyRows()[2], { shiftKey: true });
    rightClick(bodyRows()[0]);
    fireEvent.click(menuItem(/^Copy 3 rows as Tab-separated$/));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const text = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    expect(text.split("\n").slice(1)).toEqual(["2\tada", "3\tbob", "1\tcy"]);
  });

  it("reads the clicked column in the virtualized layout", () => {
    const big = makeResult();
    big.rows = Array.from({ length: 5001 }, (_, i) => [i + 1, `n${i + 1}`]);
    resultState.results = [big];
    render(<ResultsGrid />);

    // The second data cell of row 1 is the `name` column.
    fireEvent.contextMenu(screen.getByText("n1"));
    fireEvent.click(menuItem(/^Copy Cell$/));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("n1");
  });
});

describe("the grid from the keyboard (#852)", () => {
  const selectedNames = () =>
    bodyRows().filter((tr) => tr.getAttribute("aria-selected") === "true").map((tr) =>
      tr.querySelectorAll("td")[2]?.textContent?.trim()
    );
  const grid = () => screen.getByLabelText("Query results");

  it("sorts a column from its header with Enter", async () => {
    render(<ResultsGrid />);
    const header = screen.getAllByText("name")[0].closest("th");
    if (!header) throw new Error("no header");

    fireEvent.keyDown(header, { key: "Enter" });

    await waitFor(() => expect(rowNames()).toEqual(["ada", "bob", "cy"]));
  });

  it("moves and extends the selection with the arrows, in screen order", async () => {
    render(<ResultsGrid />);
    await sortByName();

    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(selectedNames()).toEqual(["ada"]);
    fireEvent.keyDown(grid(), { key: "ArrowDown", shiftKey: true });
    expect(selectedNames()).toEqual(["ada", "bob"]);
    fireEvent.keyDown(grid(), { key: "End" });
    expect(selectedNames()).toEqual(["cy"]);
  });

  it("copies the selected rows as TSV on Ctrl+C", async () => {
    render(<ResultsGrid />);
    await sortByName();
    fireEvent.click(bodyRows()[0]);
    fireEvent.click(bodyRows()[1], { shiftKey: true });

    fireEvent.keyDown(grid(), { key: "c", ctrlKey: true });

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const text = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    expect(text.split("\n").slice(1)).toEqual(["2\tada", "3\tbob"]);
  });

  it("does not let Shift+click select the cells' text", () => {
    render(<ResultsGrid />);

    expect(bodyRows()[0].className).toContain("select-none");
  });
});
