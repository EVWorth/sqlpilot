import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GridRowsProps, VirtualGridRowsProps } from "../GridRows";
import { VirtualGridRows } from "../GridRows";

// The virtualized layout positions every row itself, inside a container whose
// first child is the sticky header.

function renderVirtualRows(rowHeight = 32) {
  const rows = [0, 1, 2].map((index) => ({
    id: String(index),
    index,
    getVisibleCells: () => [],
  }));
  const table = { getRowModel: () => ({ rows }), getFlatHeaders: () => [] };
  const rowVirtualizer = {
    getVirtualItems: () => rows.map((r) => ({ index: r.index, start: r.index * rowHeight, size: rowHeight })),
  };
  const editing = {
    editMode: false,
    inserts: [],
    isRowDeleted: () => false,
    isRowEdited: () => false,
  };
  const props = {
    table: table as unknown as GridRowsProps["table"],
    data: rows.map(() => ({})),
    editing: editing as unknown as GridRowsProps["editing"],
    editingCell: null,
    selection: { rows: new Set<number>(), anchor: null },
    orderedColumns: [],
    maxContentLen: {},
    numericColumns: new Set<string>(),
    insertRowIndex: (i: number) => -1 - i,
    onEditCellAt: vi.fn(),
    onStopEditing: vi.fn(),
    onClickRow: vi.fn(),
    onRowContextMenu: vi.fn(),
    rowVirtualizer: rowVirtualizer as unknown as VirtualGridRowsProps["rowVirtualizer"],
    rowHeight,
  };
  return render(<div>{<VirtualGridRows {...props} />}</div>);
}

describe("VirtualGridRows", () => {
  it("starts row 1 below the header rather than under it (#847)", () => {
    const { container } = renderVirtualRows(32);
    const first = container.querySelector<HTMLElement>("[aria-selected]");

    expect(first?.textContent).toBe("1");
    expect(first?.style.top).toBe("32px");
    expect(first?.style.transform).toBe("translateY(0px)");
  });
});
