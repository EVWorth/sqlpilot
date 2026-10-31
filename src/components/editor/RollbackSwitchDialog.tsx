import { endedTransactionsText } from "../../lib/transaction-prompt";
import { useEditorStore } from "../../stores/editorStore";
import { useSqliteStore } from "../../stores/sqliteStore";
import { useTransactionStore } from "../../stores/transactionStore";
import { ConfirmDialog } from "../common/ConfirmDialog";

/**
 * Asks before pointing a tab at another connection, or reconnecting its
 * server, would end a session with a transaction open (#843). Ending the
 * session rolls the transaction back, as closing the tab does. On a SQLite
 * file it asks only for the last tab on the file, whose connection holds the
 * transaction for every tab on it (#935).
 */
export function RollbackSwitchDialog() {
  const pending = useEditorStore((s) => s.pendingSwitch);
  const confirm = useEditorStore((s) => s.confirmPendingSwitch);
  const cancel = useEditorStore((s) => s.cancelPendingSwitch);
  const open = useTransactionStore((s) => s.open);
  const openConnections = useTransactionStore((s) => s.openConnections);
  const files = useSqliteStore((s) => s.sessions);
  const tabs = pending?.inTransaction ?? [];
  const one = tabs.length === 1;
  const parts = endedTransactionsText(
    tabs,
    { open, openConnections },
    (id) => files.find((f) => f.id === id)?.name ?? "this file",
    "Switching",
  );
  return (
    <ConfirmDialog
      isOpen={!!pending}
      title={one ? "Switch a tab with an open transaction?" : "Switch tabs with open transactions?"}
      message={`${parts.join(" ")} Commit first to keep the changes.`}
      confirmLabel="Roll back and switch"
      danger
      onConfirm={confirm}
      onCancel={cancel}
    />
  );
}
