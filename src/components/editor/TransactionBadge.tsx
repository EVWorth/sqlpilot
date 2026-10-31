import { tabTransactionOpen, type TransactionFlags } from "../../stores/transactionStore";
import type { EditorTab } from "../../types";

/**
 * The TX mark on a tab with a transaction open where it runs (#843): on its
 * own session, or on the SQLite file's connection it shares with every other
 * tab on the file, all of which show it (#935).
 */
export function TransactionBadge({ tab, flags }: { tab: EditorTab; flags: TransactionFlags }) {
  if (!tabTransactionOpen(flags, tab)) return null;
  const shared = !flags.open[tab.id];
  return (
    <span
      className="shrink-0 rounded surface-warning px-1 text-[9px] font-semibold text-[var(--color-warning)]"
      title={shared
        ? "Transaction open on this file's connection, shared by every tab on the file: COMMIT or ROLLBACK it. "
          + "Closing the last tab on the file rolls it back."
        : "Transaction open: COMMIT or ROLLBACK it. Closing the tab rolls it back."}
    >
      TX<span className="sr-only">, transaction open</span>
    </span>
  );
}
