import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createFakeSource, type FakeRowSource } from "../../../lib/__tests__/fake-row-source";
import { createArraySource, type RowSource } from "../../../lib/row-source";
import type { QueryResult } from "../../../types";
import { GridCellContext, type GridCellState } from "../GridCell";
import type { GridRowsProps, VirtualGridRowsProps } from "../GridRows";
import { TableGridRows, VirtualGridRows } from "../GridRows";

// The rows are painted from a row source, by position in its view. The
// virtualized layout positions every row itself, inside a container whose
// first child is the sticky header.

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const result = {
  columns: [
    { name: "id", data_type: "int", nullable: false, is_primary_key: true },
    { name: "name", data_type: "varchar", nullable: true, is_primary_key: false },
  ],
  rows: [[1, "cy"], [2, "ada"], [3, "bob"]],
  sql: "SELECT * FROM users",
} as unknown as QueryResult;

const editing = {
  editMode: false,
  inserts: [],
  isRowDeleted: () => false,
  isRowEdited: () => false,
};

function propsFor(source: RowSource): GridRowsProps {
  return {
    source,
    viewCount: source.getSnapshot().viewCount,
    columnSizes: {},
    editing: editing as unknown as GridRowsProps["editing"],
    editingCell: null,
    selection: { rows: new Set<number>(), anchor: null },
    focusedCell: null,
    orderedColumns: result.columns,
    maxContentLen: {},
    numericColumns: new Set<string>(),
    insertRowIndex: (i: number) => -1 - i,
    onEditCellAt: vi.fn(),
    onStopEditing: vi.fn(),
    onClickRow: vi.fn(),
    onRowContextMenu: vi.fn(),
  };
}

function cellState(source: RowSource): GridCellState {
  return {
    result,
    source,
    editing: editing as unknown as GridCellState["editing"],
    editingCell: null,
    onEditCellAt: vi.fn(),
    onStopEditing: vi.fn(),
    onViewCell: vi.fn(),
    columnOrder: result.columns,
    wholeCell: () => undefined,
    onLoadWholeCell: vi.fn(),
    onMessage: vi.fn(),
  };
}

function Virtual(
  { source, rowHeight = 32, onClickRow = vi.fn() }: {
    source: RowSource;
    rowHeight?: number;
    onClickRow?: GridRowsProps["onClickRow"];
  },
) {
  const count = source.getSnapshot().viewCount;
  const rowVirtualizer = {
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * rowHeight, size: rowHeight })),
  };
  return (
    <GridCellContext.Provider value={cellState(source)}>
      <div>
        <VirtualGridRows
          {...propsFor(source)}
          onClickRow={onClickRow}
          rowVirtualizer={rowVirtualizer as unknown as VirtualGridRowsProps["rowVirtualizer"]}
          rowHeight={rowHeight}
        />
      </div>
    </GridCellContext.Provider>
  );
}

function Table({ source }: { source: RowSource }) {
  return (
    <GridCellContext.Provider value={cellState(source)}>
      <table>
        <tbody>
          <TableGridRows {...propsFor(source)} />
        </tbody>
      </table>
    </GridCellContext.Provider>
  );
}

/** Re-render when the source says something changed, as the grid does. */
function deliver(source: FakeRowSource, rerender: () => void, start?: number, end?: number) {
  act(() => {
    source.deliver(start, end);
    rerender();
  });
}

describe("VirtualGridRows", () => {
  it("starts row 1 below the header rather than under it (#847)", () => {
    const { container } = render(<Virtual source={createArraySource(result)} />);
    const first = container.querySelector<HTMLElement>("[aria-selected]");

    expect(first?.textContent).toBe("11cy");
    expect(first?.firstElementChild?.textContent).toBe("1");
    expect(first?.style.top).toBe("32px");
    expect(first?.style.transform).toBe("translateY(0px)");
  });

  it("paints each row at its position, keyed by its index in the result", () => {
    const source = createArraySource(result);
    source.setView([{ column: 1, descending: false }], []);
    const { container } = render(<Virtual source={source} />);

    const rows = [...container.querySelectorAll<HTMLElement>("[data-row-index]")];
    // ada (index 1), bob (2), cy (0); numbered by where they are on screen.
    expect(rows.map((r) => r.dataset.rowIndex)).toEqual(["1", "2", "0"]);
    expect(rows.map((r) => r.firstElementChild?.textContent)).toEqual(["1", "2", "3"]);
    expect(rows.map((r) => r.querySelector("[data-col='name']")?.textContent)).toEqual(["ada", "bob", "cy"]);
  });

  it("paints a placeholder of the same height for a row that is not loaded", () => {
    const source = createFakeSource(result, { loaded: 1 });
    const { container } = render(<Virtual source={source} />);

    expect(container.querySelectorAll("[data-row-index]")).toHaveLength(1);
    const placeholders = [...container.querySelectorAll<HTMLElement>("[data-row-placeholder]")];
    expect(placeholders).toHaveLength(2);
    // Where the row will be, as tall as a row, numbered, and with a slot per column.
    expect(placeholders[0].style.transform).toBe("translateY(32px)");
    expect(placeholders[0].style.height).toBe("32px");
    expect(placeholders[0].style.top).toBe("32px");
    expect(placeholders[0].firstElementChild?.textContent).toBe("2");
    expect(placeholders[0].children).toHaveLength(3);
    expect(placeholders[0].getAttribute("aria-busy")).toBe("true");
  });

  it("gives a placeholder nothing to click or select", () => {
    const source = createFakeSource(result, { loaded: 1 });
    const onClickRow = vi.fn();
    const { container } = render(<Virtual source={source} onClickRow={onClickRow} />);
    const placeholder = container.querySelector<HTMLElement>("[data-row-placeholder]");

    placeholder?.click();
    expect(placeholder?.hasAttribute("aria-selected")).toBe(false);
    expect(onClickRow).not.toHaveBeenCalled();

    // The loaded row beside it does take the click.
    container.querySelector<HTMLElement>("[data-row-index]")?.click();
    expect(onClickRow).toHaveBeenCalledTimes(1);
  });

  it("replaces the placeholders with the rows when they arrive", () => {
    const source = createFakeSource(result);
    const { container, rerender } = render(<Virtual source={source} />);
    expect(container.querySelectorAll("[data-row-placeholder]")).toHaveLength(3);
    expect(container.textContent).not.toContain("ada");

    deliver(source, () => rerender(<Virtual source={source} />), 1, 3);

    expect(container.querySelectorAll("[data-row-placeholder]")).toHaveLength(1);
    const rows = [...container.querySelectorAll<HTMLElement>("[data-row-index]")];
    expect(rows.map((r) => r.querySelector("[data-col='name']")?.textContent)).toEqual(["ada", "bob"]);
    // Still where its placeholder was.
    expect(rows[0].style.transform).toBe("translateY(32px)");
  });
});

describe("TableGridRows", () => {
  it("paints the view's rows in order", () => {
    const { container } = render(<Table source={createArraySource(result)} />);
    const rows = [...container.querySelectorAll("tr")];
    expect(rows.map((r) => r.textContent)).toEqual(["11cy", "22ada", "33bob"]);
    expect(rows.map((r) => r.getAttribute("data-row-index"))).toEqual(["0", "1", "2"]);
  });

  it("paints a placeholder row for each row that is not loaded, then the row", () => {
    const source = createFakeSource(result, { loaded: 1 });
    const { container, rerender } = render(<Table source={source} />);

    expect(container.querySelectorAll("tr")).toHaveLength(3);
    const placeholders = [...container.querySelectorAll("tr[data-row-placeholder]")];
    expect(placeholders).toHaveLength(2);
    // Numbered, one cell per column, and not empty, so it is a row's height.
    expect([...placeholders[0].querySelectorAll("td")].map((td) => td.textContent)).toEqual(["2", " ", " "]);

    deliver(source, () => rerender(<Table source={source} />));

    expect(container.querySelectorAll("tr[data-row-placeholder]")).toHaveLength(0);
    expect([...container.querySelectorAll("tr")].map((r) => r.textContent)).toEqual(["11cy", "22ada", "33bob"]);
  });
});
