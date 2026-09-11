import { CircleSlash, ClipboardCopy, ClipboardList, Copy, FileCode, Trash2 } from "lucide-react";
import { useCallback } from "react";
import type { MenuItem } from "../components/common/ContextMenu";
import { COPY_FORMAT_LABEL, type CopyFormat } from "../lib/copy-formats";
import { describeSelection, type Selection } from "../lib/grid-selection";
import type { ColumnMeta, QueryResult } from "../types";
import { SqlValueGuard } from "../types";
import type { useGridEditing } from "./useGridEditing";

/**
 * What right-clicking a row offers.
 *
 * Split out of ResultsGrid (#406). Building a menu is a pure function of the
 * cell that was clicked and what is selected, so it has no business living
 * inside a component that also owns two render paths.
 */

const COPY_FORMATS: CopyFormat[] = ["tsv", "csv", "json", "markdown", "insert", "update"];

export interface UseGridContextMenuOptions {
  result: QueryResult | undefined;
  /** Columns in display order, which is how the clicked cell is identified. */
  orderedColumns: ColumnMeta[];
  selection: Selection;
  editing: ReturnType<typeof useGridEditing>;
  showContextMenu: (e: React.MouseEvent, items: MenuItem[]) => void;
  onCopyAs: (format: CopyFormat) => void | Promise<void>;
  onSetNull: (rowIdx: number, colIdx: number) => void;
}

export function useGridContextMenu({
  result,
  orderedColumns,
  selection,
  editing,
  showContextMenu,
  onCopyAs,
  onSetNull,
}: UseGridContextMenuOptions) {
  return useCallback(
    (e: React.MouseEvent<HTMLElement>, rowIdx: number) => {
      if (!result) return;
      const td = (e.target as HTMLElement).closest("td");
      const row = result.rows[rowIdx];
      const colNames = result.columns.map((c) => c.name);

      // The cell's position in the row is its *display* position, which stops
      // being its position in the result once a column has been dragged
      // (#392).
      let cellColIdx = 0;
      if (td?.parentElement) {
        const displayIdx = Math.max(
          0,
          Array.from(td.parentElement.children).indexOf(td) - 1,
        );
        const displayed = orderedColumns[displayIdx]?.name;
        const inResult = colNames.indexOf(displayed ?? "");
        cellColIdx = inResult >= 0 ? inResult : displayIdx;
      }
      const cellValue = row[cellColIdx];
      const cellColumn = colNames[cellColIdx];
      const rowTsv = row.map((v) => SqlValueGuard.toString(v)).join("\t");
      const selectionLabel = describeSelection(selection, result.rows.length);

      // Annotated: without it the separators widen to `separator: boolean`
      // and stop matching the union.
      const menuItems: MenuItem[] = [
        {
          label: "Copy Cell",
          icon: <Copy className="h-3.5 w-3.5" />,
          onClick: () => {
            void navigator.clipboard.writeText(SqlValueGuard.toString(cellValue));
          },
        },
        {
          label: "Copy Row (Tab-separated)",
          icon: <ClipboardList className="h-3.5 w-3.5" />,
          onClick: () => {
            void navigator.clipboard.writeText(rowTsv);
          },
        },
        { separator: true },
        // FR-3.3.4/6/7. One entry per format, all acting on the selection — or
        // on the whole result when there is none, which is what "copy" with
        // nothing picked has always meant (#416).
        ...COPY_FORMATS.map((format): MenuItem => ({
          label: `Copy ${selectionLabel} as ${COPY_FORMAT_LABEL[format]}`,
          icon: format === "insert" || format === "update"
            ? <FileCode className="h-3.5 w-3.5" />
            : <ClipboardCopy className="h-3.5 w-3.5" />,
          onClick: () => void onCopyAs(format),
        })),
      ];

      if (editing.editMode) {
        menuItems.push(
          { separator: true },
          {
            // FR-3.2.3. The inline button was the only way to reach it, and it
            // only exists while a cell is already being edited (#403).
            label: `Set ${cellColumn} to NULL`,
            icon: <CircleSlash className="h-3.5 w-3.5" />,
            onClick: () => onSetNull(rowIdx, cellColIdx),
          },
          {
            label: editing.isRowDeleted(rowIdx) ? "Unmark Delete" : "Delete Row",
            icon: <Trash2 className="h-3.5 w-3.5" />,
            onClick: () => editing.deleteRow(rowIdx),
          },
        );
      }

      showContextMenu(e, menuItems);
    },
    [result, orderedColumns, selection, editing, showContextMenu, onCopyAs, onSetNull],
  );
}
