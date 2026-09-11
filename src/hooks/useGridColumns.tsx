import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { EditableCell } from "../components/grid/EditableCell";
import { TruncatedCell } from "../components/grid/TruncatedCell";
import { type GridFeatures } from "../lib/grid-features";
import { type ColumnFilter, matchesFilter } from "../lib/grid-filter";
import { nextEditableCell } from "../lib/grid-navigation";
import type { QueryResult, SqlValue } from "../types";
import type { useGridEditing } from "./useGridEditing";

/**
 * One TanStack column definition per result column, including what each cell
 * renders as.
 *
 * Split out of ResultsGrid (#406). The cell renderer is where read mode and
 * edit mode diverge, and it was buried three levels inside a component that
 * also owned the footer, the menu and the save handler.
 */

export interface CellViewerRequest {
  isOpen: boolean;
  columnName: string;
  content: string | null;
  bytes?: number[];
  dataType?: string;
}

export interface UseGridColumnsOptions {
  result: QueryResult | undefined;
  editing: ReturnType<typeof useGridEditing>;
  /** Which cell is being edited, owned by the grid rather than by the cell. */
  editingCell: { rowIndex: number; colIndex: number } | null;
  /** Longest value per column, for a sensible initial width. */
  maxContentLen: Record<string, number>;
  onEditCellAt: (rowIndex: number, colIndex: number) => void;
  onStopEditing: () => void;
  onViewCell: (request: CellViewerRequest) => void;
}

export function useGridColumns({
  result: activeResult,
  editing,
  editingCell,
  maxContentLen,
  onEditCellAt: editCellAt,
  onStopEditing: stopEditing,
  onViewCell,
}: UseGridColumnsOptions) {
  return useMemo<ColumnDef<GridFeatures, Record<string, unknown>>[]>(() => {
    if (!activeResult) return [];

    return activeResult.columns.map((col, colIdx) => ({
      id: col.name,
      accessorKey: col.name,
      header: col.name,
      // The filter value is our own ColumnFilter rather than a bare string,
      // because an operator and an operand cannot be carried by one (#391).
      filterFn: (row, columnId, value) => matchesFilter(row.getValue(columnId), value as ColumnFilter),
      cell: ({ getValue, row }) => {
        const rowIdx = row.index;
        const originalValue = getValue() as SqlValue;

        if (!editing.editMode) {
          return (
            <TruncatedCell
              value={originalValue}
              columnName={col.name}
              dataType={col.data_type}
              onViewFull={(content, colName, bytes) => {
                onViewCell({
                  isOpen: true,
                  columnName: colName,
                  content,
                  bytes,
                  dataType: col.data_type,
                });
              }}
            />
          );
        }

        const currentValue = editing.getCellValue(
          rowIdx,
          col.name,
          originalValue,
        );
        const isEdited = editing.isCellEdited(rowIdx, col.name);

        return (
          <EditableCell
            value={currentValue}
            dataType={col.data_type}
            isEdited={isEdited}
            onCommit={(newValue) => {
              editing.editCell(rowIdx, col.name, originalValue, newValue);
            }}
            editing={editingCell?.rowIndex === rowIdx && editingCell?.colIndex === colIdx}
            onEditingChange={(on) => (on ? editCellAt(rowIdx, colIdx) : stopEditing())}
            onTab={(shiftKey) => {
              const next = nextEditableCell(
                { rowIndex: rowIdx, colIndex: colIdx },
                shiftKey,
                activeResult.rows.length,
                activeResult.columns.length,
              );
              if (!next) {
                stopEditing();
                return;
              }
              editCellAt(next.rowIndex, next.colIndex);
            }}
          />
        );
      },
      size: Math.max(80, Math.min(350, Math.min(maxContentLen[col.name] ?? 5, 30) * 9 + 40)),
    }));
    // editingCell belongs here: the cell renderers close over it, so leaving
    // it out would keep rendering the previously-memoised cells and the edit
    // would never appear to move.
  }, [activeResult, editing, editingCell, editCellAt, stopEditing, maxContentLen, onViewCell]);
}
