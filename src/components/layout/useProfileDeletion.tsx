import { useState } from "react";
import { useConnectionStore } from "../../stores/connectionStore";
import type { ConnectionProfileSummary } from "../../types";
import { ConfirmDialog } from "../common/ConfirmDialog";

/**
 * Deleting a saved profile, behind a confirmation (FR-1.1.3).
 *
 * "Delete Profile" used to disconnect and delete at once, with no way back
 * (#795). `requestDelete` asks first; only a confirm closes the profile's
 * connections and deletes it. It works whether or not the profile is
 * connected, so one that cannot connect can still be removed.
 */
export function useProfileDeletion() {
  const [pending, setPending] = useState<ConnectionProfileSummary | null>(null);
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const disconnect = useConnectionStore((s) => s.disconnect);
  const deleteProfile = useConnectionStore((s) => s.deleteProfile);

  const openCount = pending
    ? activeConnections.filter((c) => c.profile_id === pending.id).length
    : 0;

  const handleConfirm = async () => {
    if (!pending) return;
    const profile = pending;
    setPending(null);
    const open = useConnectionStore.getState().activeConnections.filter(
      (c) => c.profile_id === profile.id,
    );
    for (const conn of open) {
      await disconnect(conn.id);
    }
    // disconnect reports its own failure. A connection still open must not
    // outlive its profile, so stop rather than delete under it.
    const stillOpen = useConnectionStore.getState().activeConnections.some(
      (c) => c.profile_id === profile.id,
    );
    if (stillOpen) return;
    await deleteProfile(profile.id);
  };

  const name = pending ? pending.name || pending.host : "";
  const message = openCount > 0
    ? `"${name}" will be removed from your saved connections, along with its stored password. It is connected now; its open tabs will be disconnected. This cannot be undone.`
    : `"${name}" will be removed from your saved connections, along with its stored password. This cannot be undone.`;

  const confirmDialog = (
    <ConfirmDialog
      isOpen={pending !== null}
      title="Delete connection profile?"
      message={message}
      confirmLabel="Delete"
      danger
      onConfirm={() => void handleConfirm()}
      onCancel={() => setPending(null)}
    />
  );

  return { requestDelete: setPending, confirmDialog };
}
