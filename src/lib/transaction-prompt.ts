import type { TransactionFlags } from "../stores/transactionStore";
import type { EditorTab } from "../types";

/**
 * What the close and switch prompts say about the transactions they would
 * roll back (#843, #935).
 *
 * A MySQL tab's transaction is on its own session, which closing or
 * switching the tab ends. A SQLite tab's is on the file's one connection,
 * and the prompt comes up only for the last tab on the file — so it says so,
 * rather than claiming the tab had a session of its own.
 */
export function endedTransactionsText(
  tabs: readonly EditorTab[],
  flags: TransactionFlags,
  /** The file's name for a SQLite connection id. */
  fileName: (connectionId: string) => string,
  verb: "Closing" | "Switching",
): string[] {
  const names = (list: readonly EditorTab[]) => list.map((t) => `"${t.title}"`).join(", ");
  const byFile = new Map<string, EditorTab[]>();
  const own: EditorTab[] = [];
  for (const t of tabs) {
    if (!flags.open[t.id] && t.connectionId !== undefined && flags.openConnections[t.connectionId]) {
      byFile.set(t.connectionId, [...(byFile.get(t.connectionId) ?? []), t]);
    } else {
      own.push(t);
    }
  }
  const parts: string[] = [];
  if (own.length > 0) {
    parts.push(
      `${names(own)} ${own.length === 1 ? "has a transaction" : "have transactions"} open. `
        + `${verb} ends the session, which rolls back everything not committed.`,
    );
  }
  for (const [connectionId, list] of byFile) {
    parts.push(
      `${names(list)} ${list.length === 1 ? "is the last tab" : "are the last tabs"} on ${fileName(connectionId)}, `
        + `and a transaction is open on the file's connection. `
        + `${verb} rolls back everything not committed on it.`,
    );
  }
  return parts;
}
