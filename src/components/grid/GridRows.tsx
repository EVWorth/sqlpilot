import { flexRender, type Table } from "@tanstack/react-table";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { useGridEditing } from "../../hooks/useGridEditing";
import type { GridFeatures } from "../../lib/grid-features";
import type { Selection } from "../../lib/grid-selection";
import type { ColumnMeta, SqlValue } from "../../types";
import { EditableCell } from "./EditableCell";

/**
 * The rows themselves, in the grid's two layouts.
 *
 * A plain table below 5000 rows and an absolutely-positioned virtual list
 * above it. They draw the same thing and are kept apart only because
 * virtualizing a `<table>` means fighting its layout; everything that decides
 * *what* a row looks like — selection, pending edits, pending deletes — is
 * shared here rather than written twice (#406).
 */

export interface GridRowsProps {
  table: Table<GridFeatures, Record<string, unknown>>;
  /** The rows as objects, which is also how the insert-row count is derived. */
  data: Record<string, SqlValue>[];
  editing: ReturnType<typeof useGridEditing>;
  editingCell: { rowIndex: number; colIndex: number } | null;
  selection: Selection;
  /** Columns in display order, for the insert rows laid out by hand (#392). */
  orderedColumns: ColumnMeta[];
  maxContentLen: Record<string, number>;
  numericColumns: ReadonlySet<string>;
  /** Pending insert rows use negative indices, so one piece of state covers both grids. */
  insertRowIndex: (insertIdx: number) => number;
  onEditCellAt: (rowIndex: number, colIndex: number) => void;
  onStopEditing: () => void;
  onClickRow: (e: React.MouseEvent, rowIdx: number) => void;
  onRowContextMenu: (e: React.MouseEvent<HTMLElement>, rowIdx: number) => void;
}

export interface VirtualGridRowsProps extends GridRowsProps {
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  rowHeight: number;
}

export function VirtualGridRows({
  table,
  data,
  editing,
  editingCell,
  selection,
  orderedColumns,
  maxContentLen,
  numericColumns,
  insertRowIndex,
  onEditCellAt: editCellAt,
  onStopEditing: stopEditing,
  onClickRow: clickRow,
  onRowContextMenu: handleRowContextMenu,
  rowVirtualizer,
}: VirtualGridRowsProps) {
  return (
    <>
      {/* Virtual rows */}
      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
        const rowIdx = virtualRow.index;
        const isInsert = rowIdx >= data.length;
        const insertIdx = rowIdx - data.length;
        const tableRow = !isInsert ? table.getRowModel().rows[rowIdx] : null;

        if (isInsert && editing.editMode) {
          const insertRow = editing.inserts[insertIdx];
          return (
            <div
              key={`insert-${insertIdx}`}
              style={{
                display: "flex",
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
                height: `${virtualRow.size}px`,
              }}
            >
              <div
                className="flex items-center justify-center border-b border-r border-[var(--color-border)] bg-green-900/15 px-2 py-1 text-center text-green-400 text-xs"
                style={{ flex: "0 0 48px" }}
              >
                +
              </div>
              {orderedColumns.map((col, colIdx) => {
                // Not colIdx + 1: the row-number column is markup
                // beside the table, not one of its columns, so the
                // offset read every insert cell's width from its
                // neighbour.
                const header = table.getFlatHeaders()[colIdx];
                const colSize = header ? header.getSize() : 150;
                const minW = Math.max(50, Math.min(maxContentLen[col.name] ?? 5, 20) * 7 + 30);
                return (
                  <div
                    key={col.name}
                    className="border-b border-r border-[var(--color-border)] bg-green-900/15 px-2 py-1 text-xs text-[var(--color-text-primary)]"
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

        if (!tableRow) return null;
        const isDeleted = editing.isRowDeleted(rowIdx);
        const isEdited = editing.isRowEdited(rowIdx);
        const isSelected = selection.rows.has(rowIdx);
        let rowBg = "";
        if (isDeleted) rowBg = "bg-red-900/20 line-through opacity-60";
        else if (isEdited) rowBg = "bg-amber-900/10";
        else if (isSelected) rowBg = "bg-brand-600/20";
        else rowBg = "hover:bg-[var(--color-bg-secondary)]";

        return (
          <div
            key={tableRow.id}
            aria-selected={isSelected}
            onClick={(e) => clickRow(e, rowIdx)}
            onContextMenu={(e) => handleRowContextMenu(e, rowIdx)}
            style={{
              display: "flex",
              position: "absolute",
              top: 0,
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
            {tableRow.getVisibleCells().map((cell) => {
              const minW = Math.max(50, Math.min(maxContentLen[cell.column.id] ?? 5, 20) * 7 + 30);
              return (
                <div
                  key={cell.id}
                  className={`border-b border-r border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-primary)] ${rowBg} ${
                    numericColumns.has(cell.column.id) ? "text-right tabular-nums" : ""
                  }`}
                  style={{ flex: `1 1 ${cell.column.getSize()}px`, minWidth: minW }}
                >
                  {flexRender(
                    cell.column.columnDef.cell,
                    cell.getContext(),
                  )}
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
  table,
  editing,
  editingCell,
  selection,
  orderedColumns,
  numericColumns,
  insertRowIndex,
  onEditCellAt: editCellAt,
  onStopEditing: stopEditing,
  onClickRow: clickRow,
  onRowContextMenu: handleRowContextMenu,
}: GridRowsProps) {
  return (
    <>
      {table.getRowModel().rows.map((row, rowIdx) => {
        const isDeleted = editing.isRowDeleted(rowIdx);
        const isEdited = editing.isRowEdited(rowIdx);
        const isSelected = selection.rows.has(rowIdx);
        let rowClass = "hover:bg-[var(--color-bg-secondary)]";
        if (isDeleted) rowClass = "bg-red-900/20 line-through opacity-60";
        else if (isEdited) rowClass = "bg-amber-900/10";
        else if (isSelected) rowClass = "bg-brand-600/20";

        return (
          <tr
            key={row.id}
            className={rowClass}
            aria-selected={isSelected}
            onClick={(e) => clickRow(e, rowIdx)}
            onContextMenu={(e) => handleRowContextMenu(e, rowIdx)}
          >
            <td className="border-b border-r border-[var(--color-border)] px-2 py-1 text-center text-[var(--color-text-muted)]">
              {rowIdx + 1}
            </td>
            {row.getVisibleCells().map((cell) => (
              <td
                key={cell.id}
                className={`border-b border-r border-[var(--color-border)] px-2 py-1 text-[var(--color-text-primary)] ${
                  numericColumns.has(cell.column.id) ? "text-right tabular-nums" : ""
                }`}
              >
                {flexRender(
                  cell.column.columnDef.cell,
                  cell.getContext(),
                )}
              </td>
            ))}
          </tr>
        );
      })}
      {editing.editMode
        && editing.inserts.map((insertRow, insertIdx) => (
          <tr key={`insert-${insertIdx}`} className="bg-green-900/15">
            <td className="border-b border-r border-[var(--color-border)] px-2 py-1 text-center text-green-400">
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
