import { createContext, useContext, useEffect } from "react";
import type { useGridEditing } from "../../hooks/useGridEditing";
import { nextEditableCell } from "../../lib/grid-navigation";
import type { ResultMeta, RowSource, SourceRow } from "../../lib/row-source";
import type { ColumnMeta, SqlValue } from "../../types";
import { EditableCell } from "./EditableCell";
import { TruncatedCell } from "./TruncatedCell";

/**
 * One data cell of the grid, in read mode or edit mode.
 *
 * A component of its own, and the one every column renders, so its identity
 * never changes. The renderers used to be closures rebuilt whenever the
 * editing state changed — which was every render. React then unmounted and
 * remounted every cell, so the first click of a double-click (which selects
 * the row and re-renders) swapped the element out from under the second, and
 * no `dblclick` ever fired (#841). What changes from render to render arrives
 * through context instead.
 *
 * The value it paints comes from the row source and may be cut short. A cut
 * value is never shown in the viewer, copied or edited as it is: the whole
 * one is asked of the source first.
 */

export interface CellViewerRequest {
  isOpen: boolean;
  columnName: string;
  content: string | null;
  bytes?: number[];
  dataType?: string;
}

export interface GridCellState {
  result: ResultMeta;
  source: RowSource;
  editing: ReturnType<typeof useGridEditing>;
  /** Which cell is being edited, owned by the grid rather than by the cell. */
  editingCell: { rowIndex: number; colIndex: number } | null;
  onEditCellAt: (rowIndex: number, colIndex: number) => void;
  onStopEditing: () => void;
  onViewCell: (request: CellViewerRequest) => void;
  /** The result's columns in display order, so Tab follows a drag. */
  columnOrder: readonly ColumnMeta[];
  /** The whole value of a cut cell, once `onLoadWholeCell` has fetched it. */
  wholeCell: (rowIndex: number, colIndex: number) => { value: SqlValue } | undefined;
  /** Fetch a cut cell's whole value, for editing it. */
  onLoadWholeCell: (rowIndex: number, colIndex: number) => void;
  onMessage: (message: string) => void;
}

export const GridCellContext = createContext<GridCellState | null>(null);

export interface GridCellProps {
  row: SourceRow;
  /** The column's position in the result, not on screen. */
  colIdx: number;
}

export function GridCell({ row, colIdx }: GridCellProps) {
  const state = useContext(GridCellContext);
  const rowIdx = row.index;
  const fullLen = row.fullLens?.[colIdx] ?? null;
  const isCut = fullLen !== null;
  const whole = state && isCut ? state.wholeCell(rowIdx, colIdx) : undefined;
  const isEditingThis = Boolean(
    state?.editing.editMode && state.editingCell?.rowIndex === rowIdx && state.editingCell.colIndex === colIdx,
  );
  // Editing starts from the whole value, so a cut cell waits for it.
  const needsWhole = isEditingThis && isCut && whole === undefined;
  const loadWholeCell = state?.onLoadWholeCell;
  useEffect(() => {
    if (needsWhole) loadWholeCell?.(rowIdx, colIdx);
  }, [needsWhole, loadWholeCell, rowIdx, colIdx]);

  if (!state) return null;
  const {
    result,
    source,
    editing,
    onEditCellAt: editCellAt,
    onStopEditing: stopEditing,
    onViewCell,
    columnOrder,
    onMessage,
  } = state;

  const col = result.columns[colIdx];
  if (!col) return null;
  const paintedValue = row.values[colIdx];

  if (!editing.editMode) {
    return (
      <TruncatedCell
        value={paintedValue}
        columnName={col.name}
        dataType={col.data_type}
        fullLen={fullLen}
        loadFull={isCut
          ? () =>
            source.cell(rowIdx, colIdx).catch((e: unknown) => {
              onMessage(`Could not load ${col.name}: ${String(e)}`);
              throw e;
            })
          : undefined}
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

  // The value as fetched: the whole one where the painted one is cut.
  const originalValue = whole ? whole.value : paintedValue;

  return (
    <EditableCell
      value={editing.getCellValue(rowIdx, col.name, originalValue)}
      dataType={col.data_type}
      isEdited={editing.isCellEdited(rowIdx, col.name)}
      onCommit={(newValue) => {
        editing.editCell(rowIdx, col.name, originalValue, newValue);
      }}
      editing={isEditingThis && !needsWhole}
      onEditingChange={(on) => (on ? editCellAt(rowIdx, colIdx) : stopEditing())}
      onTab={(shiftKey) => {
        const cols = columnOrder.map((c) => result.columns.findIndex((rc) => rc.name === c.name));
        const colPos = cols.indexOf(colIdx);
        // Along the row, nothing needs asking.
        const beside = cols[colPos + (shiftKey ? -1 : 1)];
        if (colPos >= 0 && beside !== undefined) {
          editCellAt(rowIdx, beside);
          return;
        }
        // Off the end of the row: on to the next row on screen, which is the
        // source's to say. Stepping through result indices jumped about a
        // sorted grid (#858).
        void (async () => {
          const position = await source.positionOf(rowIdx);
          const next = position === null ? null : nextEditableCell(
            { rowIndex: position, colIndex: colPos },
            shiftKey,
            source.getSnapshot().viewCount,
            cols.length,
          );
          const [nextRow] = next ? await source.indicesAt(next.rowIndex, next.rowIndex + 1) : [];
          const nextCol = next ? cols[next.colIndex] : undefined;
          if (nextRow === undefined || nextCol === undefined) {
            stopEditing();
            return;
          }
          editCellAt(nextRow, nextCol);
        })().catch(() => stopEditing());
      }}
    />
  );
}
