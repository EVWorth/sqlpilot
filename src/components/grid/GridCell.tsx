import type { CellContext } from "@tanstack/react-table";
import { createContext, useContext } from "react";
import type { useGridEditing } from "../../hooks/useGridEditing";
import type { GridFeatures } from "../../lib/grid-features";
import { nextEditableCell } from "../../lib/grid-navigation";
import type { QueryResult, SqlValue } from "../../types";
import { EditableCell } from "./EditableCell";
import { TruncatedCell } from "./TruncatedCell";

/**
 * One data cell of the grid, in read mode or edit mode.
 *
 * A component of its own, and the one every column renders, so its identity
 * never changes. TanStack's flexRender treats each cell renderer as a
 * component type, and the renderers used to be closures rebuilt whenever the
 * editing state changed — which was every render. React then unmounted and
 * remounted every cell, so the first click of a double-click (which selects
 * the row and re-renders) swapped the element out from under the second, and
 * no `dblclick` ever fired (#841). What changes from render to render arrives
 * through context instead.
 */

export interface CellViewerRequest {
  isOpen: boolean;
  columnName: string;
  content: string | null;
  bytes?: number[];
  dataType?: string;
}

export interface GridCellState {
  result: QueryResult;
  editing: ReturnType<typeof useGridEditing>;
  /** Which cell is being edited, owned by the grid rather than by the cell. */
  editingCell: { rowIndex: number; colIndex: number } | null;
  onEditCellAt: (rowIndex: number, colIndex: number) => void;
  onStopEditing: () => void;
  onViewCell: (request: CellViewerRequest) => void;
}

export const GridCellContext = createContext<GridCellState | null>(null);

export function GridCell({ getValue, row, column }: CellContext<GridFeatures, Record<string, unknown>, unknown>) {
  const state = useContext(GridCellContext);
  if (!state) return null;
  const { result, editing, editingCell, onEditCellAt: editCellAt, onStopEditing: stopEditing, onViewCell } = state;

  const colIdx = result.columns.findIndex((c) => c.name === column.id);
  const col = result.columns[colIdx];
  if (!col) return null;
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

  return (
    <EditableCell
      value={editing.getCellValue(rowIdx, col.name, originalValue)}
      dataType={col.data_type}
      isEdited={editing.isCellEdited(rowIdx, col.name)}
      onCommit={(newValue) => {
        editing.editCell(rowIdx, col.name, originalValue, newValue);
      }}
      editing={editingCell?.rowIndex === rowIdx && editingCell?.colIndex === colIdx}
      onEditingChange={(on) => (on ? editCellAt(rowIdx, colIdx) : stopEditing())}
      onTab={(shiftKey) => {
        const next = nextEditableCell(
          { rowIndex: rowIdx, colIndex: colIdx },
          shiftKey,
          result.rows.length,
          result.columns.length,
        );
        if (!next) {
          stopEditing();
          return;
        }
        editCellAt(next.rowIndex, next.colIndex);
      }}
    />
  );
}
