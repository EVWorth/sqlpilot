import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSource, type FakeRowSource } from "../../../lib/__tests__/fake-row-source";
import { api } from "../../../lib/tauri-api";
import type { QueryResult, SqlValue } from "../../../types";
import { ResultsGrid } from "../ResultsGrid";

// The grid over a row source that behaves like one reading from the backend
// (docs/design/RESULT_STORE.md): rows are not there until they arrive, long
// values are painted cut short, and every answer is a promise the test
// settles. The grid must paint what it has, wait for what it has not, and
// never mistake the part of a value it painted for the value.

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
      const s = { tabs: [], activeTabId: "tab-1" };
      return selector ? selector(s) : s;
    },
    { getState: () => ({ tabs: [], activeTabId: "tab-1" }) },
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

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    exportResults: vi.fn(async () => "id,name\n"),
    executeQuery: vi.fn(),
    getColumns: vi.fn(async () => [
      { name: "id", data_type: "int", nullable: false, is_primary_key: true },
      { name: "name", data_type: "varchar", nullable: false, is_primary_key: false },
    ]),
    getIndexes: vi.fn(async () => []),
  },
  CommandError: class CommandError extends Error {},
}));

// Monaco does not run in jsdom; what the viewer was opened on is all that
// matters here.
vi.mock("../CellViewerModal", () => ({
  CellViewerModal: (
    { isOpen, columnName, content, bytes }: {
      isOpen: boolean;
      columnName: string;
      content: string | null;
      bytes?: number[];
    },
  ) => (
    <div
      data-testid="cell-viewer"
      data-open={isOpen}
      data-column={columnName}
      data-content={content ?? ""}
      data-bytes={bytes ? bytes.join(",") : ""}
    />
  ),
}));

// jsdom has no layout, so the real virtualizer shows nothing. This one shows
// the first ten rows.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 10) }, (_, index) => ({ index, start: index * 32, size: 32 })),
  }),
}));

// The grid gets the fake in place of the in-memory source.
let fake: FakeRowSource;
vi.mock("../../../lib/row-source", async (original) => ({
  ...(await original<typeof import("../../../lib/row-source")>()),
  rowSourceFor: (result: QueryResult | undefined) => (result ? fake : createFakeSource(emptyResult())),
}));

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const LONG = "a long note that goes on well past where it is cut";

function makeResult(rows?: SqlValue[][]): QueryResult {
  return {
    columns: [
      { name: "id", data_type: "int", nullable: false, is_primary_key: false },
      { name: "name", data_type: "varchar", nullable: false, is_primary_key: false },
    ],
    // Sorted by name, the order on screen is 2 (ada), 3 (bob), 1 (cy).
    rows: rows ?? [[1, "cy"], [2, "ada"], [3, "bob"]],
    rows_affected: 0,
    execution_time_ms: 1,
    sql: "SELECT * FROM users",
  } as unknown as QueryResult;
}

function emptyResult(): QueryResult {
  return { ...makeResult([]), columns: [] };
}

/** Mount the grid over a fake source of `result`. */
function mount(result = makeResult(), options: Parameters<typeof createFakeSource>[1] = {}) {
  fake = createFakeSource(result, options);
  resultState.results = [result];
  return render(<ResultsGrid />);
}

const bodyRows = () => [...document.querySelectorAll("tbody tr")] as HTMLElement[];
const placeholders = () => [...document.querySelectorAll("[data-row-placeholder]")];
const rowNames = () =>
  bodyRows().filter((tr) => tr.hasAttribute("data-row-index")).map((tr) =>
    tr.querySelector("[data-col='name']")?.textContent?.trim()
  );
const menuItem = (label: RegExp) => within(document.body).getByRole("menuitem", { name: label });
const grid = () => screen.getByLabelText("Query results");
const viewer = () => screen.getByTestId("cell-viewer");
const clipboard = () => vi.mocked(navigator.clipboard.writeText);
/** Let whatever the source has already answered reach the grid. */
const settle = () => act(async () => {});
const release = () =>
  act(async () => {
    fake.release();
  });

beforeEach(() => {
  resultState.resultSource = { connectionId: "conn-1", database: "app" };
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
  URL.createObjectURL = vi.fn(() => "blob:test");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("rows that have not arrived", () => {
  it("paints a placeholder for each, counted and numbered, then the rows", () => {
    mount();

    // The count is the source's, known before any row is.
    expect(screen.getByText(/3 row\(s\)/)).toBeInTheDocument();
    expect(placeholders()).toHaveLength(3);
    expect(placeholders().map((p) => p.firstElementChild?.textContent)).toEqual(["1", "2", "3"]);
    expect(rowNames()).toEqual([]);

    act(() => fake.deliver(0, 2));
    expect(placeholders()).toHaveLength(1);
    expect(rowNames()).toEqual(["cy", "ada"]);

    act(() => fake.deliver());
    expect(placeholders()).toHaveLength(0);
    expect(rowNames()).toEqual(["cy", "ada", "bob"]);
  });

  it("does the same in the virtualized layout, and says which rows are on screen", () => {
    const rows = Array.from({ length: 5001 }, (_, i): SqlValue[] => [i + 1, `n${i + 1}`]);
    mount(makeResult(rows));

    expect(placeholders()).toHaveLength(10);
    expect(document.querySelectorAll("[data-row-index]")).toHaveLength(0);
    expect(fake.visibleRanges.at(-1)).toEqual([0, 10]);

    act(() => fake.deliver(0, 4));
    expect(placeholders()).toHaveLength(6);
    expect(
      [...document.querySelectorAll("[data-row-index]")].map((r) => r.querySelector("[data-col='name']")?.textContent),
    )
      .toEqual(["n1", "n2", "n3", "n4"]);
  });

  it("tells the source every row is on screen in the table layout", () => {
    mount();
    expect(fake.visibleRanges.at(-1)).toEqual([0, 3]);
  });

  it("sizes its columns from the rows it has, without asking for the rest", () => {
    mount(makeResult(), { held: true });
    act(() => fake.deliver(0, 1));
    expect(fake.asked).toEqual([]);
  });
});

describe("sorting and filtering are the source's", () => {
  it("hands a header click to the source and repaints from it", () => {
    mount(makeResult(), { loaded: 3 });
    expect(fake.views.at(-1)).toEqual({ sort: [], filters: [] });

    fireEvent.click(screen.getAllByText("name")[0]);

    expect(fake.views.at(-1)).toEqual({ sort: [{ column: 1, descending: false }], filters: [] });
    // A new view: its rows have to arrive before they can be painted.
    expect(placeholders()).toHaveLength(3);
    act(() => fake.deliver());
    expect(rowNames()).toEqual(["ada", "bob", "cy"]);
    expect(screen.getAllByText("name")[0].closest("th")?.getAttribute("aria-sort")).toBe("ascending");

    fireEvent.click(screen.getAllByText("name")[0]);
    expect(fake.views.at(-1)).toEqual({ sort: [{ column: 1, descending: true }], filters: [] });
    fireEvent.click(screen.getAllByText("name")[0]);
    expect(fake.views.at(-1)).toEqual({ sort: [], filters: [] });
  });

  it("adds a sort key on Shift+click, in the order clicked (#392)", () => {
    mount(makeResult(), { loaded: 3 });
    fireEvent.click(screen.getAllByText("name")[0]);
    fireEvent.click(screen.getAllByText("id")[0], { shiftKey: true });

    expect(fake.views.at(-1)).toEqual({
      sort: [{ column: 1, descending: false }, { column: 0, descending: false }],
      filters: [],
    });
    expect(screen.getByLabelText("Sort priority 2")).toBeInTheDocument();
  });

  it("hands a filter to the source and counts from it", async () => {
    mount(makeResult(), { loaded: 3 });
    fireEvent.click(screen.getByLabelText("Filter name"));
    fireEvent.change(await screen.findByLabelText("Filter name value"), { target: { value: "b" } });

    expect(fake.views.at(-1)).toEqual({
      sort: [],
      filters: [{ column: 1, operator: "contains", value: "b", value2: null }],
    });
    expect(screen.getByText(/1 of 3 row\(s\)/)).toBeInTheDocument();
    expect(placeholders()).toHaveLength(1);
    act(() => fake.deliver());
    expect(rowNames()).toEqual(["bob"]);
  });
});

describe("copy and export wait for the source", () => {
  it("copies everything only once the source has answered", async () => {
    mount(makeResult(), { loaded: 3, held: true });

    fireEvent.click(screen.getByTitle("Copy as tab-separated values"));
    await settle();
    expect(fake.asked).toContain("rows");
    expect(clipboard()).not.toHaveBeenCalled();
    expect(screen.queryByText(/Copied/)).toBeNull();

    await release();
    await waitFor(() => expect(clipboard()).toHaveBeenCalledWith("id\tname\n1\tcy\n2\tada\n3\tbob"));
    expect(await screen.findByText("Copied 3 rows to clipboard")).toBeInTheDocument();
  });

  it("copies rows it never painted", async () => {
    // Nothing loaded: the copy is of the result, not of what is on screen.
    mount(makeResult(), { loaded: 0 });
    fireEvent.click(screen.getByTitle("Copy as tab-separated values"));
    await waitFor(() => expect(clipboard()).toHaveBeenCalledWith("id\tname\n1\tcy\n2\tada\n3\tbob"));
  });

  it("copies a selection, in screen order, only once the source has answered", async () => {
    mount(makeResult(), { loaded: 3 });
    fireEvent.click(screen.getAllByText("name")[0]);
    act(() => fake.deliver());
    // ada (2), bob (3), cy (1) on screen.
    fireEvent.click(bodyRows()[0]);
    fireEvent.click(bodyRows()[2], { shiftKey: true });
    await waitFor(() => expect(bodyRows()[2].getAttribute("aria-selected")).toBe("true"));

    fake.hold();
    fireEvent.contextMenu(bodyRows()[0].querySelectorAll("td")[1]);
    fireEvent.click(menuItem(/^Copy 3 rows as Tab-separated$/));
    await settle();
    expect(clipboard()).not.toHaveBeenCalled();

    await release();
    await waitFor(() => expect(clipboard()).toHaveBeenCalledWith("id\tname\n2\tada\n3\tbob\n1\tcy"));
    expect(fake.asked).toEqual(expect.arrayContaining(["order", "rows"]));
    expect(await screen.findByText("Copied 3 rows as Tab-separated")).toBeInTheDocument();
  });

  it("says so, and writes nothing, when the source cannot give the rows", async () => {
    mount(makeResult(), { loaded: 3 });
    fake.failWith(new Error("the result was released"));

    fireEvent.click(screen.getByTitle("Copy as tab-separated values"));

    expect(await screen.findByText("Copy failed: Error: the result was released")).toBeInTheDocument();
    expect(clipboard()).not.toHaveBeenCalled();
  });

  it("exports only once the source has answered, with every row", async () => {
    mount(makeResult(), { loaded: 1, held: true });

    fireEvent.click(screen.getByTitle("Download CSV"));
    await settle();
    expect(api.exportResults).not.toHaveBeenCalled();

    await release();
    await waitFor(() => expect(api.exportResults).toHaveBeenCalled());
    const [exported, format] = vi.mocked(api.exportResults).mock.calls[0];
    expect(format).toBe("csv");
    expect(exported.rows).toEqual([[1, "cy"], [2, "ada"], [3, "bob"]]);
    expect(exported.sql).toBe("SELECT * FROM users");
    expect(await screen.findByText("Exported 3 rows as CSV")).toBeInTheDocument();
  });

  it("reports a failed export as it always has", async () => {
    mount(makeResult(), { loaded: 3 });
    fake.failWith(new Error("the result was released"));

    fireEvent.click(screen.getByTitle("Download CSV"));

    expect(await screen.findByText("Export failed — try Copy instead")).toBeInTheDocument();
    expect(api.exportResults).not.toHaveBeenCalled();
  });

  it("waits for the source before moving the selection from the keyboard", async () => {
    mount(makeResult(), { loaded: 3 });
    fireEvent.click(bodyRows()[0]);
    fake.hold();

    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    await settle();
    expect(bodyRows()[0].getAttribute("aria-selected")).toBe("true");

    // Both steps land, one after the other: on the third row, not the second.
    await release();
    await waitFor(() => expect(bodyRows()[2].getAttribute("aria-selected")).toBe("true"));
    expect(bodyRows()[0].getAttribute("aria-selected")).toBe("false");
    expect(bodyRows()[1].getAttribute("aria-selected")).toBe("false");
  });
});

describe("a cell that was cut short", () => {
  const cutResult = () => makeResult([[1, LONG], [2, "ada"]]);

  it("paints the part it has, marked as a part", () => {
    mount(cutResult(), { loaded: 2, cutAt: 6 });
    expect(screen.getByText("a long…")).toBeInTheDocument();
    expect(screen.queryByText(LONG)).toBeNull();
  });

  it("fetches the whole value before the viewer shows it", async () => {
    mount(cutResult(), { loaded: 2, cutAt: 6, held: true });

    fireEvent.click(within(bodyRows()[0]).getByLabelText("View full content"));
    await settle();
    expect(fake.asked).toEqual(["cell"]);
    // Not opened on the part.
    expect(viewer().dataset.open).toBe("false");

    await release();
    await waitFor(() => expect(viewer().dataset.open).toBe("true"));
    expect(viewer().dataset.content).toBe(LONG);
    expect(viewer().dataset.column).toBe("name");
  });

  it("fetches the whole of a BLOB before the viewer shows it", async () => {
    const bytes = Array.from({ length: 40 }, (_, i) => i);
    mount(makeResult([[1, bytes]]), { loaded: 1, cutAt: 6 });

    fireEvent.click(within(bodyRows()[0]).getByLabelText("View full content"));

    await waitFor(() => expect(viewer().dataset.open).toBe("true"));
    expect(viewer().dataset.bytes).toBe(bytes.join(","));
  });

  it("says so, and opens nothing, when the whole value cannot be had", async () => {
    mount(cutResult(), { loaded: 2, cutAt: 6 });
    fake.failWith(new Error("the result was released"));

    fireEvent.click(within(bodyRows()[0]).getByLabelText("View full content"));

    expect(await screen.findByText("Could not load name: Error: the result was released")).toBeInTheDocument();
    expect(viewer().dataset.open).toBe("false");
  });

  it("copies the whole value from the cell's own Copy", async () => {
    mount(cutResult(), { loaded: 2, cutAt: 6 });
    fireEvent.click(within(bodyRows()[0]).getByLabelText("Copy value"));
    await waitFor(() => expect(clipboard()).toHaveBeenCalledWith(LONG));
  });

  it("copies the whole value from the context menu, for the cell and for the row", async () => {
    mount(cutResult(), { loaded: 2, cutAt: 6 });

    fireEvent.contextMenu(bodyRows()[0].querySelectorAll("td")[2]);
    fireEvent.click(menuItem(/^Copy Cell$/));
    await waitFor(() => expect(clipboard()).toHaveBeenCalledWith(LONG));

    fireEvent.contextMenu(bodyRows()[0].querySelectorAll("td")[2]);
    fireEvent.click(menuItem(/^Copy Row/));
    await waitFor(() => expect(clipboard()).toHaveBeenCalledWith(`1\t${LONG}`));
  });

  it("copies the whole value with Ctrl+C on the focused cell", async () => {
    mount(cutResult(), { loaded: 2, cutAt: 6 });
    fireEvent.click(screen.getByText("a long…"));
    fireEvent.keyDown(grid(), { key: "Escape" });

    fireEvent.keyDown(grid(), { key: "c", ctrlKey: true });

    await waitFor(() => expect(clipboard()).toHaveBeenCalledWith(LONG));
    expect(await screen.findByText("Copied name")).toBeInTheDocument();
  });

  it("includes the whole value in a copy of rows", async () => {
    mount(cutResult(), { loaded: 2, cutAt: 6 });
    fireEvent.click(bodyRows()[0]);
    fireEvent.keyDown(grid(), { key: "c", ctrlKey: true });

    await waitFor(() => expect(clipboard()).toHaveBeenCalledWith(`id\tname\n1\t${LONG}`));
  });

  it("starts an edit from the whole value, once it has it", async () => {
    mount(cutResult(), { loaded: 2, cutAt: 6, held: true });
    fireEvent.click(screen.getByRole("button", { name: /edit mode/i }));

    fireEvent.doubleClick(screen.getByText("a long"));
    await settle();
    // No editor on the part: typing over it would save the part.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(fake.asked).toEqual(["cell"]);

    await release();
    expect(await screen.findByDisplayValue(LONG)).toBeInTheDocument();
  });

  it("gives up the edit, and says so, when the whole value cannot be had", async () => {
    mount(cutResult(), { loaded: 2, cutAt: 6 });
    fireEvent.click(screen.getByRole("button", { name: /edit mode/i }));
    fake.failWith(new Error("the result was released"));

    fireEvent.doubleClick(screen.getByText("a long"));

    expect(await screen.findByText("Could not load name: Error: the result was released")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("edits a cell that is whole without asking the source", async () => {
    mount(cutResult(), { loaded: 2, cutAt: 6, held: true });
    fireEvent.click(screen.getByRole("button", { name: /edit mode/i }));

    fireEvent.doubleClick(screen.getByText("ada"));

    expect(await screen.findByDisplayValue("ada")).toBeInTheDocument();
    expect(fake.asked).toEqual([]);
  });
});
