import { useCallback, useState } from "react";
import { describeGridChanges } from "../lib/grid-navigation";
import { runGridEdits, runStatement } from "../lib/run-statement";
import {
  type ColumnTypes,
  generateDelete,
  generateInsert,
  generateUpdate,
  resolveEditTarget,
} from "../lib/sql-generator";
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

    // The statement and connection the rows were read with, never the
    // editor's current text or connection: the user may have kept typing, or
    // pointed the tab elsewhere, since this result arrived. Saving against
    // either wrote the edits into whatever table the editor named now (#840).
    const sql = result.sql ?? "";

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

    // Where the result on screen was read: the connection, the database it
    // ran against and the tab's session. The edits are saved there and the
    // refresh reads from there, so a result that depends on the session — a
    // temporary table, a session variable, the tab's open transaction — is
    // edited and re-read where it exists (#735).
    const source = useResultStore.getState().resultSource;
    if (!source) {
      onMessage("Cannot save: the connection this result came from is unknown. Run the query again.");
      return;
    }
    const connId = source.connectionId;
    const { session, database } = source;
    // The tab this grid belongs to, fixed now: the user can switch tabs while
    // the confirmation or the save is awaited, and a refresh with no session
    // would otherwise land in whichever query tab they moved to (#842).
    const tabId = useResultStore.getState().viewTabId ?? undefined;

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
      let insideTransaction = false;
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

        // On the tab's session the backend decides how to wrap the edits:
        // in a transaction of their own, or inside the user's open one
        // without committing it. Null means it could not tell, and nothing
        // was applied, so the save falls back to the shared pool.
        const outcome = session
          ? await runGridEdits({ connectionId: connId, session, database, statements })
          : null;
        if (outcome) {
          matched = outcome.rows_affected.reduce((sum, n) => sum + n, 0);
          insideTransaction = outcome.transaction === "open";
        } else {
          // One transaction, so a statement that fails halfway leaves nothing
          // half-applied.
          const batch = "START TRANSACTION;\n" + statements.join(";\n") + ";\nCOMMIT;";
          const results = await runStatement({ connectionId: connId, sql: batch, database, origin: "grid" });
          matched = results.reduce((sum, r) => sum + Number(r.rows_affected ?? 0), 0);
        }
      }

      editing.discardAll();
      await useResultStore.getState().executeQuery(connId, sql, database, session, tabId);

      // A WHERE that matches nothing is not an error — the statement runs and
      // affects zero rows — so the save reported success either way (#419).
      if (statements.length > 0 && matched < statements.length) {
        onMessage(
          `Only ${matched} of ${statements.length} change(s) matched a row. The rest changed `
            + `nothing — the values they matched on may no longer be in the table.`,
        );
      } else if (insideTransaction) {
        // Applied, but only inside the user's transaction: nobody else sees
        // the change until they commit, and a rollback undoes it with the
        // rest of their work.
        onMessage(
          `Applied ${statements.length} change(s) inside your open transaction. `
            + `COMMIT to keep them, or ROLLBACK to undo them.`,
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
