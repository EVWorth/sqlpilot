import { useCallback, useState } from "react";
import { describeGridChanges } from "../lib/grid-navigation";
import { runStatement } from "../lib/run-statement";
import {
  type ColumnTypes,
  generateDelete,
  generateInsert,
  generateUpdate,
  resolveEditTarget,
} from "../lib/sql-generator";
import { useConnectionStore } from "../stores/connectionStore";
import { useEditorStore } from "../stores/editorStore";
import { confirmDestructive } from "../stores/productionGuardStore";
import { useResultStore } from "../stores/resultStore";
import type { QueryResult, SqlValue } from "../types";
import type { useGridEditing } from "./useGridEditing";
import type { RowKey } from "./useRowKey";

/**
 * Turning pending grid edits into statements, and running them as one batch.
 *
 * Split out of ResultsGrid (#406). It is the part with the most ways to go
 * wrong and the least to do with rendering, which is exactly the combination
 * that belongs outside a 1400-line component.
 */

export interface UseGridSaveOptions {
  result: QueryResult | undefined;
  editing: ReturnType<typeof useGridEditing>;
  rowKey: RowKey;
  /** Why rows cannot be identified, when they cannot (#387). */
  keyWarning: string | null;
  columnTypes: ColumnTypes;
  onMessage: (message: string) => void;
}

export function useGridSave({
  result,
  editing,
  rowKey,
  keyWarning,
  columnTypes,
  onMessage,
}: UseGridSaveOptions) {
  const [isSaving, setIsSaving] = useState(false);

  /** The row as it was fetched, which is what an UPDATE or DELETE matches on. */
  const originalRow = useCallback((rowIdx: number): Record<string, SqlValue> => {
    if (!result) return {};
    const row = result.rows[rowIdx];
    const obj: Record<string, SqlValue> = {};
    result.columns.forEach((col, idx) => {
      obj[col.name] = row[idx];
    });
    return obj;
  }, [result]);

  const save = useCallback(async () => {
    if (!result) return;

    const editorTab = useEditorStore.getState().tabs.find(
      (t) => t.id === useEditorStore.getState().activeTabId,
    );
    const sql = editorTab?.content ?? "";

    // Where the edit would land, or why it must not be attempted. The old
    // check took the first table in the FROM clause, which for a join is
    // whichever is listed first — not necessarily the one that owns the
    // edited column (#399).
    const target = resolveEditTarget(sql);
    if (!target.editable) {
      onMessage(`Cannot save: ${target.reason}`);
      return;
    }
    const tableName = target.table;

    const connId = editorTab?.connectionId
      ?? useConnectionStore.getState().selectedConnectionId;
    if (!connId) {
      onMessage("No active connection");
      return;
    }

    setIsSaving(true);
    try {
      // Already resolved when the result loaded, so Save does not repeat the
      // schema read and the user was warned before editing rather than after.
      if (rowKey.state.status === "key-not-selected") {
        onMessage(`Cannot save: ${keyWarning ?? "rows cannot be identified"}`);
        return;
      }
      const keyColumns = rowKey.columns;

      const statements: string[] = [];

      for (const [rowIdx, changes] of editing.updates) {
        statements.push(
          generateUpdate(
            tableName,
            keyColumns,
            originalRow(rowIdx),
            changes.map((c) => ({ column: c.column, newValue: c.newValue })),
            columnTypes,
          ),
        );
      }

      for (const insertRow of editing.inserts) {
        const cols = result.columns.map((c) => c.name);
        statements.push(generateInsert(tableName, cols, insertRow, columnTypes));
      }

      for (const rowIdx of editing.deletes) {
        statements.push(generateDelete(tableName, keyColumns, originalRow(rowIdx), columnTypes));
      }

      let matched = 0;
      if (statements.length > 0) {
        // The gate lives in resultStore, which this path does not go through
        // — so until #588 a cell edit on production wrote with no
        // confirmation at all. Asked once for the batch, and about every
        // write rather than only the destructive verbs, because editing a
        // cell is direct manipulation rather than a composed statement.
        const confirmed = await confirmDestructive({
          connectionId: connId,
          sql: statements,
          action: `Apply ${statements.length} change(s) to \`${tableName}\`?`,
          detail: describeGridChanges({
            updates: editing.updates.size,
            inserts: editing.inserts.length,
            deletes: editing.deletes.size,
          }),
          alwaysAsk: true,
        });
        if (!confirmed) return;

        // One transaction, so a statement that fails halfway leaves nothing
        // half-applied.
        const batch = "START TRANSACTION;\n" + statements.join(";\n") + ";\nCOMMIT;";
        const results = await runStatement({ connectionId: connId, sql: batch, origin: "grid" });
        matched = results.reduce((sum, r) => sum + Number(r.rows_affected ?? 0), 0);
      }

      editing.discardAll();
      await useResultStore.getState().executeQuery(connId, sql);

      // A WHERE that matches nothing is not an error — the statement runs and
      // affects zero rows — so the save reported success either way (#419).
      if (statements.length > 0 && matched < statements.length) {
        onMessage(
          `Only ${matched} of ${statements.length} change(s) matched a row. The rest changed `
            + `nothing — the values they matched on may no longer be in the table.`,
        );
      } else {
        onMessage(`Applied ${statements.length} change(s)`);
      }
    } catch (e) {
      onMessage(`Save failed: ${String(e)}`);
    } finally {
      setIsSaving(false);
    }
  }, [result, editing, originalRow, rowKey, keyWarning, onMessage, columnTypes]);

  return { isSaving, save };
}
