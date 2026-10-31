import { useEditorStore } from "../stores/editorStore";
import { useTransactionStore } from "../stores/transactionStore";
import type { EditorTab } from "../types";
import type { TransactionState } from "./bindings";
import { api, CommandError } from "./tauri-api";

/**
 * Transactions on a SQLite file's connection, and when to end one (#935).
 *
 * A SQLite file has one connection, shared by every tab bound to it, so a
 * BEGIN in one tab is open in all of them and the state belongs to the
 * connection (`useTransactionStore.openConnections`). It ends where a MySQL
 * tab's does, when nothing is left to run on it: once the last tab bound to
 * the file has closed or been pointed elsewhere — which the editor asks about
 * first (`transactionsEndedBy`) — this rolls it back, so "Roll back and
 * close" does what it says rather than leaving the work pending on a
 * connection no tab shows. Closing the file itself ends it too; SQLite rolls
 * back as the connection closes, and `sqliteStore.close` forgets the flag.
 *
 * One subscription on the editor store, as `server-sessions.ts` has for MySQL
 * sessions, so every way a tab goes is covered.
 */

/** Record what the file's connection reported after a run. */
export function noteSqliteTransaction(connectionId: string, state: TransactionState | null | undefined) {
  if (!state) return;
  useTransactionStore.getState().setConnectionOpen(connectionId, state === "open");
  if (state === "open") watchTabs();
}

/**
 * Connections with a transaction open that `before` had a tab bound to and
 * `after` has none: those the editor has just let go of.
 *
 * Only a connection that had a tab is counted, so a run on the file from no
 * tab's session does not have its transaction rolled back the next time any
 * tab changes. A tab with no connection is bound to the file by its first run
 * there (#942), so its transaction is counted like any other tab's.
 */
export function connectionsLeft(
  openConnections: Readonly<Record<string, true>>,
  before: readonly Pick<EditorTab, "connectionId">[],
  after: readonly Pick<EditorTab, "connectionId">[],
): string[] {
  return Object.keys(openConnections).filter((id) =>
    before.some((t) => t.connectionId === id) && !after.some((t) => t.connectionId === id)
  );
}

async function rollBack(connectionId: string) {
  try {
    const results = await api.sqliteExecute(connectionId, "ROLLBACK");
    const last = results[results.length - 1];
    useTransactionStore.getState().setConnectionOpen(connectionId, last ? last.in_transaction : false);
  } catch (e) {
    // Nothing here is worth interrupting the user over: the file may have
    // closed meanwhile. What the connection reported, when it did, still
    // stands, so a tab opened on the file later shows it.
    if (e instanceof CommandError && e.transaction) {
      useTransactionStore.getState().setConnectionOpen(connectionId, e.transaction === "open");
    }
    console.warn(`Could not roll back the transaction on ${connectionId}`, e);
  }
}

let watching = false;

/** Start watching the tabs, once, when the first transaction opens. */
function watchTabs() {
  if (watching) return;
  watching = true;
  let lastTabs = useEditorStore.getState().tabs;
  useEditorStore.subscribe((state) => {
    if (state.tabs === lastTabs) return;
    const before = lastTabs;
    lastTabs = state.tabs;
    for (const id of connectionsLeft(useTransactionStore.getState().openConnections, before, state.tabs)) {
      void rollBack(id);
    }
  });
}
