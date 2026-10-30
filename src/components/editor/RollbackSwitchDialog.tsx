import { useEditorStore } from "../../stores/editorStore";
import { ConfirmDialog } from "../common/ConfirmDialog";

/**
 * Asks before pointing a tab at another connection, or reconnecting its
 * server, would end a session with a transaction open (#843). Ending the
 * session rolls the transaction back, as closing the tab does.
 */
export function RollbackSwitchDialog() {
  const pending = useEditorStore((s) => s.pendingSwitch);
  const confirm = useEditorStore((s) => s.confirmPendingSwitch);
  const cancel = useEditorStore((s) => s.cancelPendingSwitch);
  const tabs = pending?.inTransaction ?? [];
  const one = tabs.length === 1;
  const names = tabs.map((t) => `"${t.title}"`).join(", ");
  return (
    <ConfirmDialog
      isOpen={!!pending}
      title={one ? "Switch a tab with an open transaction?" : "Switch tabs with open transactions?"}
      message={`${names} ${one ? "has a transaction" : "have transactions"} open. `
        + "Switching ends the session, which rolls back everything not committed. "
        + "Commit first to keep the changes."}
      confirmLabel="Roll back and switch"
      danger
      onConfirm={confirm}
      onCancel={cancel}
    />
  );
}
