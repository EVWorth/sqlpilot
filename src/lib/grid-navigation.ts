/**
 * Where Tab takes the edit next.
 *
 * The grid owns which cell is being edited, so this is the only part of the
 * move that has any logic in it: run off the end of a row and the edit
 * carries on into the next one, run off the end of the grid and it stops
 * rather than wrapping round to a cell the user is not looking at (#408).
 */
export interface CellPosition {
  rowIndex: number;
  colIndex: number;
}

export function nextEditableCell(
  from: CellPosition,
  shiftKey: boolean,
  rowCount: number,
  columnCount: number,
): CellPosition | null {
  const lastCol = columnCount - 1;
  const lastRow = rowCount - 1;
  if (lastCol < 0 || lastRow < 0) return null;

  let rowIndex = from.rowIndex;
  let colIndex = shiftKey ? from.colIndex - 1 : from.colIndex + 1;

  if (colIndex > lastCol) {
    rowIndex += 1;
    colIndex = 0;
  } else if (colIndex < 0) {
    rowIndex -= 1;
    colIndex = lastCol;
  }

  if (rowIndex < 0 || rowIndex > lastRow) return null;
  return { rowIndex, colIndex };
}

/**
 * A one-line summary of pending grid edits, for the production confirmation.
 *
 * The dialog has to say what is about to be written. "Apply 12 change(s)"
 * alone does not distinguish twelve cell edits from twelve deleted rows.
 */
export function describeGridChanges(counts: {
  updates: number;
  inserts: number;
  deletes: number;
}): string {
  const parts: string[] = [];
  if (counts.updates) parts.push(`${counts.updates} row(s) updated`);
  if (counts.inserts) parts.push(`${counts.inserts} row(s) inserted`);
  if (counts.deletes) parts.push(`${counts.deletes} row(s) deleted`);
  return parts.join(", ");
}
