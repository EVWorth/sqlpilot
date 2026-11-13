import type { Virtualizer } from "@tanstack/react-virtual";
import type { useGridEditing } from "../../hooks/useGridEditing";
import type { Selection } from "../../lib/grid-selection";
import type { RowSource } from "../../lib/row-source";
import type { ColumnMeta } from "../../types";
import { EditableCell } from "./EditableCell";
import { GridCell } from "./GridCell";

/**
 * The rows themselves, in the grid's two layouts.
 *
 * A plain table below 5000 rows and an absolutely-positioned virtual list
 * above it. They draw the same thing and are kept apart only because
 * virtualizing a `<table>` means fighting its layout; everything that decides
 * *what* a row looks like — selection, pending edits, pending deletes — is
 * shared here rather than written twice (#406).
 *
 * Rows are painted from the row source, by position in its view. A position
 * whose row has not arrived paints as a placeholder of the same height, with
 * its row number and nothing to click, until the source says it has it.
 */

export interface GridRowsProps {
  source: RowSource;
  /** Rows in the source's view: the positions to paint, before any insert rows. */
  viewCount: number;
  /** Each column's width by name, as the header has it. */
  columnSizes: Record<string, number>;
  editing: ReturnType<typeof useGridEditing>;
  editingCell: { rowIndex: number; colIndex: number } | null;
  selection: Selection;
  /** The cell the arrow keys move, by result row and column name (#852). */
  focusedCell: { rowIndex: number; columnName: string } | null;
  /** Columns in display order (#392). */
  orderedColumns: ColumnMeta[];
  maxContentLen: Record<string, number>;
  numericColumns: ReadonlySet<string>;
  /** Pending insert rows use negative indices, so one piece of state covers both grids. */
  insertRowIndex: (insertIdx: number) => number;
  onEditCellAt: (rowIndex: number, colIndex: number) => void;
  onStopEditing: () => void;
  /** Both take the row's index in the result, not its position on screen (#839). */
  onClickRow: (e: React.MouseEvent, dataIdx: number) => void;
  onRowContextMenu: (e: React.MouseEvent<HTMLElement>, dataIdx: number) => void;
}

/** The focused cell's outline, inside its borders so it does not shift the layout. */
const FOCUSED_CELL = "outline outline-2 -outline-offset-2 outline-brand-500";

/** Where each display column is in the result, which is how a row's values are laid out. */
const resultPositions = (source: RowSource, orderedColumns: ColumnMeta[]) =>
  orderedColumns.map((col) => ({ col, colIdx: source.columns.findIndex((c) => c.name === col.name) }));

const isFocused = (
  focusedCell: GridRowsProps["focusedCell"],
  rowIndex: number,
  columnName: string,
) => focusedCell?.rowIndex === rowIndex && focusedCell.columnName === columnName;

export interface VirtualGridRowsProps extends GridRowsProps {
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  /** Also the sticky header's height, which every row is offset by. */
  rowHeight: number;
}

export function VirtualGridRows({
  source,
  viewCount,
  columnSizes,
  editing,
  editingCell,
  selection,
  focusedCell,
  orderedColumns,
  maxContentLen,
  numericColumns,
  insertRowIndex,
  onEditCellAt: editCellAt,
  onStopEditing: stopEditing,
  onClickRow: clickRow,
  onRowContextMenu: handleRowContextMenu,
  rowVirtualizer,
  rowHeight,
}: VirtualGridRowsProps) {
  const cells = resultPositions(source, orderedColumns);
  const minWidth = (name: string) => Math.max(50, Math.min(maxContentLen[name] ?? 5, 20) * 7 + 30);
  return (
    <>
      {/* Virtual rows */}
      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
        const rowIdx = virtualRow.index;
        const isInsert = rowIdx >= viewCount;
        const insertIdx = rowIdx - viewCount;
        const row = !isInsert ? source.rowAt(rowIdx) : undefined;

        if (isInsert && editing.editMode) {
          const insertRow = editing.inserts[insertIdx];
          if (!insertRow) return null;
          return (
            <div
              key={`insert-${insertIdx}`}
              style={{
                display: "flex",
                position: "absolute",
                top: rowHeight,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
                height: `${virtualRow.size}px`,
              }}
            >
              <div
                className="flex items-center justify-center border-b border-r border-[var(--color-border)] surface-success px-2 py-1 text-center text-[var(--color-success)] text-xs"
                style={{ flex: "0 0 48px" }}
              >
                +
              </div>
              {orderedColumns.map((col, colIdx) => {
                const colSize = columnSizes[col.name] ?? 150;
                const minW = minWidth(col.name);
                return (
                  <div
                    key={col.name}
                    className="border-b border-r border-[var(--color-border)] surface-success px-2 py-1 text-xs text-[var(--color-text-primary)]"
                    style={{ flex: `1 1 ${colSize}px`, minWidth: minW }}
                  >
                    <EditableCell
                      value={insertRow[col.name] === undefined ? null : insertRow[col.name]}
                      dataType={col.data_type}
                      isEdited={insertRow[col.name] !== undefined}
                      onCommit={(newValue) => {
                        editing.editInsertCell(insertIdx, col.name, newValue);
                      }}
                      editing={editingCell?.rowIndex === insertRowIndex(insertIdx)
                        && editingCell?.colIndex === colIdx}
                      onEditingChange={(on) => on ? editCellAt(insertRowIndex(insertIdx), colIdx) : stopEditing()}
                    />
                  </div>
                );
              })}
            </div>
          );
        }

        if (isInsert) return null;
        if (!row) {
          return (
            <div
              key={`placeholder-${rowIdx}`}
              data-row-placeholder
              aria-busy="true"
              style={{
                display: "flex",
                position: "absolute",
                top: rowHeight,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
                height: `${virtualRow.size}px`,
              }}
            >
              <div
                className="flex items-center justify-center border-b border-r border-[var(--color-border)] px-2 py-1 text-center text-xs text-[var(--color-text-muted)]"
                style={{ flex: "0 0 48px" }}
              >
                {rowIdx + 1}
              </div>
              {cells.map(({ col }) => (
                <div
                  key={col.name}
                  className="border-b border-r border-[var(--color-border)] px-2 py-1"
                  style={{ flex: `1 1 ${columnSizes[col.name] ?? 150}px`, minWidth: minWidth(col.name) }}
                />
              ))}
            </div>
          );
        }
        // The row's index in the result, not its place on screen: once the
        // grid is sorted or filtered the two differ, and every pending edit,
        // delete and selection is keyed by the former (#839).
        const dataIdx = row.index;
        const isDeleted = editing.isRowDeleted(dataIdx);
        const isEdited = editing.isRowEdited(dataIdx);
        const isSelected = selection.rows.has(dataIdx);
        let rowBg = "";
        if (isDeleted) rowBg = "surface-error-strong line-through opacity-60";
        else if (isEdited) rowBg = "surface-warning";
        else if (isSelected) rowBg = "bg-brand-600/20";
        else rowBg = "hover:bg-[var(--color-bg-secondary)]";

        return (
          <div
            key={dataIdx}
            data-row-index={dataIdx}
            aria-selected={isSelected}
            onClick={(e) => clickRow(e, dataIdx)}
            onContextMenu={(e) => handleRowContextMenu(e, dataIdx)}
            style={{
              display: "flex",
              position: "absolute",
              // Below the sticky header, which is the container's first
              // child and one row tall; at 0 it covered row 1 (#847).
              top: rowHeight,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start}px)`,
              height: `${virtualRow.size}px`,
            }}
          >
            <div
              className={`flex items-center justify-center border-b border-r border-[var(--color-border)] px-2 py-1 text-center text-xs text-[var(--color-text-muted)] ${rowBg}`}
              style={{ flex: "0 0 48px" }}
            >
              {rowIdx + 1}
            </div>
            {cells.map(({ col, colIdx }) => {
              const focused = isFocused(focusedCell, dataIdx, col.name);
              return (
                <div
                  key={col.name}
                  data-col={col.name}
                  data-focused-cell={focused || undefined}
                  className={`select-none border-b border-r border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-primary)] ${rowBg} ${
                    numericColumns.has(col.name) ? "text-right tabular-nums" : ""
                  } ${focused ? FOCUSED_CELL : ""}`}
                  style={{ flex: `1 1 ${columnSizes[col.name] ?? 150}px`, minWidth: minWidth(col.name) }}
                >
                  <GridCell row={row} colIdx={colIdx} />
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

export function TableGridRows({
  source,
  viewCount,
  editing,
  editingCell,
  selection,
  focusedCell,
  orderedColumns,
  numericColumns,
  insertRowIndex,
  onEditCellAt: editCellAt,
  onStopEditing: stopEditing,
  onClickRow: clickRow,
  onRowContextMenu: handleRowContextMenu,
}: GridRowsProps) {
  const cells = resultPositions(source, orderedColumns);
  return (
    <>
      {Array.from({ length: viewCount }, (_, rowIdx) => {
        const row = source.rowAt(rowIdx);
        if (!row) {
          return (
            <tr key={`placeholder-${rowIdx}`} data-row-placeholder aria-busy="true">
              <td className="border-b border-r border-[var(--color-border)] px-2 py-1 text-center text-[var(--color-text-muted)]">
                {rowIdx + 1}
              </td>
              {cells.map(({ col }) => (
                // A space, so the row is as tall as one with values in it.
                <td key={col.name} className="border-b border-r border-[var(--color-border)] px-2 py-1">
                  {"\u00a0"}
                </td>
              ))}
            </tr>
          );
        }
        // Keyed by the row's index in the result, not its place on screen,
        // which differ once the grid is sorted or filtered (#839).
        const dataIdx = row.index;
        const isDeleted = editing.isRowDeleted(dataIdx);
        const isEdited = editing.isRowEdited(dataIdx);
        const isSelected = selection.rows.has(dataIdx);
        let rowClass = "hover:bg-[var(--color-bg-secondary)]";
        if (isDeleted) rowClass = "surface-error-strong line-through opacity-60";
        else if (isEdited) rowClass = "surface-warning";
        else if (isSelected) rowClass = "bg-brand-600/20";

        return (
          <tr
            key={dataIdx}
            data-row-index={dataIdx}
            // No text selection: Shift+click picks rows, and a highlight
            // across their cells as well read as a second, different
            // selection (#852). The cell viewer still copies a value's text.
            className={`select-none ${rowClass}`}
            aria-selected={isSelected}
            onClick={(e) => clickRow(e, dataIdx)}
            onContextMenu={(e) => handleRowContextMenu(e, dataIdx)}
          >
            <td className="border-b border-r border-[var(--color-border)] px-2 py-1 text-center text-[var(--color-text-muted)]">
              {rowIdx + 1}
            </td>
            {cells.map(({ col, colIdx }) => {
              const focused = isFocused(focusedCell, dataIdx, col.name);
              return (
                <td
                  key={col.name}
                  data-col={col.name}
                  data-focused-cell={focused || undefined}
                  className={`border-b border-r border-[var(--color-border)] px-2 py-1 text-[var(--color-text-primary)] ${
                    numericColumns.has(col.name) ? "text-right tabular-nums" : ""
                  } ${focused ? FOCUSED_CELL : ""}`}
                >
                  <GridCell row={row} colIdx={colIdx} />
                </td>
              );
            })}
          </tr>
        );
      })}
      {editing.editMode
        && editing.inserts.map((insertRow, insertIdx) => (
          <tr key={`insert-${insertIdx}`} className="surface-success">
            <td className="border-b border-r border-[var(--color-border)] px-2 py-1 text-center text-[var(--color-success)]">
              +
            </td>
            {orderedColumns.map((col, colIdx) => (
              <td
                key={col.name}
                data-column={col.name}
                className="border-b border-r border-[var(--color-border)] px-2 py-1 text-[var(--color-text-primary)]"
              >
                <EditableCell
                  value={insertRow[col.name] === undefined
                    ? null
                    : insertRow[col.name]}
                  dataType={col.data_type}
                  isEdited={insertRow[col.name] !== undefined}
                  onCommit={(newValue) => {
                    editing.editInsertCell(insertIdx, col.name, newValue);
                  }}
                  editing={editingCell?.rowIndex === insertRowIndex(insertIdx)
                    && editingCell?.colIndex === colIdx}
                  onEditingChange={(on) => on ? editCellAt(insertRowIndex(insertIdx), colIdx) : stopEditing()}
                />
              </td>
            ))}
          </tr>
        ))}
    </>
  );
}
