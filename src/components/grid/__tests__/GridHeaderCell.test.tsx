import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GridHeaderCell, type GridHeaderCellProps } from "../GridHeaderCell";

/**
 * The header is rendered twice by the grid — once virtualized, once as a
 * table — so these exercise the one component both paths use (#392, #406).
 */

function props(over: Partial<GridHeaderCellProps> = {}): GridHeaderCellProps {
  return {
    as: "div",
    columnId: "email",
    label: "email",
    sortIndex: 0,
    sortDirection: false,
    showSortPriority: false,
    numeric: false,
    canResize: true,
    isResizing: false,
    onSort: vi.fn(),
    onResizeStart: vi.fn(),
    onAutoSize: vi.fn(),
    onDropColumn: vi.fn(),
    isDropTarget: false,
    onDragStateChange: vi.fn(),
    ...over,
  };
}

/**
 * A stand-in for DataTransfer.
 *
 * These run under jsdom rather than the browser suite on purpose: Chromium
 * puts DataTransfer in protected mode, so a synthetic drag event carries no
 * readable payload and every drop looks empty. The handlers under test are
 * ours; the clipboard plumbing is the browser's.
 */
function dragging(type: string, value: string) {
  return {
    types: [type],
    dropEffect: "",
    effectAllowed: "",
    setData: () => {},
    getData: (t: string) => (t === type ? value : ""),
  };
}

const COLUMN_MIME = "application/x-sqlpilot-column";

describe("GridHeaderCell", () => {
  describe("sorting", () => {
    it("passes the event through so Shift can add a sort key", () => {
      // Without the event, multi-sort is unreachable: TanStack decides from
      // the modifier, not from a separate call (#392).
      const onSort = vi.fn();
      render(<GridHeaderCell {...props({ onSort })} />);

      fireEvent.click(screen.getByTitle(/Shift\+click/), { shiftKey: true });

      expect(onSort).toHaveBeenCalledTimes(1);
      expect(onSort.mock.calls[0][0].shiftKey).toBe(true);
    });

    it("shows which key a column is when several are sorting", () => {
      render(
        <GridHeaderCell
          {...props({ sortDirection: "desc", sortIndex: 2, showSortPriority: true })}
        />,
      );
      expect(screen.getByLabelText("Sort priority 2")).toBeInTheDocument();
    });

    it("shows no priority badge for a single sort", () => {
      render(<GridHeaderCell {...props({ sortDirection: "asc", sortIndex: 1 })} />);
      expect(screen.queryByLabelText(/Sort priority/)).not.toBeInTheDocument();
    });

    it("reports the sort direction to assistive technology", () => {
      const { rerender } = render(<GridHeaderCell {...props({ sortDirection: "asc" })} />);
      expect(screen.getByTitle(/sort/).getAttribute("aria-sort")).toBe("ascending");

      rerender(<GridHeaderCell {...props({ sortDirection: false })} />);
      expect(screen.getByTitle(/sort/).getAttribute("aria-sort")).toBe("none");
    });
  });

  describe("type badge (#414)", () => {
    it("shows the column's SQL type beside its name", () => {
      // It was carried all the way to the frontend and never rendered, so
      // telling tinyint(1) from a small integer meant leaving the grid.
      render(<GridHeaderCell {...props({ columnId: "age", dataType: "INT" })} />);
      expect(screen.getByTitle("age INT")).toBeInTheDocument();
    });

    it("shows nothing when the type is unknown", () => {
      render(<GridHeaderCell {...props({ dataType: undefined })} />);
      expect(screen.queryByText("INT")).not.toBeInTheDocument();
    });
  });

  describe("reordering", () => {
    it("reports the column that was dropped onto this one", () => {
      const onDropColumn = vi.fn();
      render(<GridHeaderCell {...props({ columnId: "id", onDropColumn })} />);

      fireEvent.drop(screen.getByTitle(/drag to reorder/), {
        dataTransfer: dragging(COLUMN_MIME, "email"),
      });

      expect(onDropColumn).toHaveBeenCalledWith("email");
    });

    it("ignores a column dropped on itself", () => {
      const onDropColumn = vi.fn();
      render(<GridHeaderCell {...props({ columnId: "email", onDropColumn })} />);

      fireEvent.drop(screen.getByTitle(/drag to reorder/), {
        dataTransfer: dragging(COLUMN_MIME, "email"),
      });

      expect(onDropColumn).not.toHaveBeenCalled();
    });

    it("accepts the drop by preventing the default refusal", () => {
      // Without preventDefault on dragover the browser rejects the drop and
      // nothing ever moves.
      render(<GridHeaderCell {...props()} />);

      const accepted = !fireEvent.dragOver(
        screen.getByTitle(/drag to reorder/),
        { dataTransfer: dragging(COLUMN_MIME, "id") },
      );

      expect(accepted).toBe(true);
    });

    it("ignores a drag that is not one of our columns", () => {
      // A file dragged onto the grid must not be treated as a reorder.
      const onDragStateChange = vi.fn();
      render(<GridHeaderCell {...props({ onDragStateChange })} />);

      fireEvent.dragOver(screen.getByTitle(/drag to reorder/), {
        dataTransfer: dragging("text/plain", "hello"),
      });

      expect(onDragStateChange).not.toHaveBeenCalled();
    });

    it("is not draggable when reordering is not offered", () => {
      render(<GridHeaderCell {...props({ onDropColumn: undefined })} />);
      const header = screen.getByTitle(/Click to sort/);
      expect(header.getAttribute("draggable")).toBe("false");
      expect(header.getAttribute("title")).not.toMatch(/reorder/);
    });
  });

  describe("resizing", () => {
    it("does not start a sort or a reorder from the resize handle", () => {
      const onSort = vi.fn();
      const onResizeStart = vi.fn();
      render(<GridHeaderCell {...props({ onSort, onResizeStart })} />);

      const handle = screen.getByTitle(/Drag to resize/);
      fireEvent.mouseDown(handle);
      fireEvent.click(handle);

      expect(onResizeStart).toHaveBeenCalled();
      expect(onSort).not.toHaveBeenCalled();
      expect(handle.getAttribute("draggable")).toBe("false");
    });

    it("fits the column on a double-click", () => {
      const onAutoSize = vi.fn();
      render(<GridHeaderCell {...props({ onAutoSize })} />);

      fireEvent.doubleClick(screen.getByTitle(/Drag to resize/));

      expect(onAutoSize).toHaveBeenCalled();
    });

    it("offers no handle when the column cannot be resized", () => {
      render(<GridHeaderCell {...props({ canResize: false })} />);
      expect(screen.queryByTitle(/Drag to resize/)).not.toBeInTheDocument();
    });
  });
});
