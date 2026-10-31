import { endedTransactionsText } from "../../lib/transaction-prompt";
import { useEditorStore } from "../../stores/editorStore";
import { useSqliteStore } from "../../stores/sqliteStore";
import { useTransactionStore } from "../../stores/transactionStore";
import { ConfirmDialog } from "../common/ConfirmDialog";

/**
 * Asks before a close would discard a tab's unsaved SQL or roll back an open
 * transaction (#843): the tab's own, or that of the SQLite file it is the last
 * tab on (#935).
 */
export function UnsavedCloseDialog() {
  const pending = useEditorStore((s) => s.pendingClose);
  const confirm = useEditorStore((s) => s.confirmPendingClose);
  const cancel = useEditorStore((s) => s.cancelPendingClose);
  const open = useTransactionStore((s) => s.open);
  const openConnections = useTransactionStore((s) => s.openConnections);
  const files = useSqliteStore((s) => s.sessions);
  const names = (tabs: { title: string }[]) => tabs.map((t) => `"${t.title}"`).join(", ");
  const inTx = pending?.inTransaction ?? [];
  const unsaved = (pending?.atRisk ?? []).filter((t) => !inTx.includes(t));
  const one = pending?.atRisk.length === 1;
  const parts = endedTransactionsText(
    inTx,
    { open, openConnections },
    (id) => files.find((f) => f.id === id)?.name ?? "this file",
    "Closing",
  );
  if (unsaved.length > 0) {
    parts.push(
      `${names(unsaved)} ${
        unsaved.length === 1 ? "has" : "have"
      } SQL that is not saved anywhere else. Closing discards it.`,
    );
  }
  return (
    <ConfirmDialog
      isOpen={!!pending}
      title={inTx.length > 0
        ? (one ? "Close tab with an open transaction?" : "Close tabs with open transactions?")
        : (one ? "Close tab with unsaved SQL?" : "Close tabs with unsaved SQL?")}
      message={parts.join("\n\n")}
      confirmLabel={inTx.length > 0 ? "Roll back and close" : "Discard and close"}
      danger
      onConfirm={confirm}
      onCancel={cancel}
    />
  );
}
