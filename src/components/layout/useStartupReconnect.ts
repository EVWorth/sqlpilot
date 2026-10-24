import { useEffect } from "react";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";

/**
 * Load the saved profiles, then reconnect the ones the restored editor tabs
 * were using, and say which could not be reached (#276, #804).
 *
 * Moved out of `ConnectionTabs` unchanged, to keep that component readable.
 */
export function useStartupReconnect() {
  useEffect(() => {
    const init = async () => {
      await useConnectionStore.getState().loadProfiles();

      // Auto-reconnect profiles that were active in the previous session
      const { tabs, setTabConnection: setTabConn } = useEditorStore.getState();
      const profileIds = [
        ...new Set(
          tabs.filter((t) => t.profileId).map((t) => t.profileId!),
        ),
      ];

      const failed: string[] = [];
      const failedIds: string[] = [];
      for (const profileId of profileIds) {
        try {
          const conn = await useConnectionStore.getState().connect(profileId);
          // Update all tabs belonging to this profile with the new runtime connection ID
          useEditorStore.getState().tabs
            .filter((t) => t.profileId === profileId)
            .forEach((t) => setTabConn(t.id, conn.id, t.database, profileId));
          // Select this connection if the active tab belongs to it
          const { activeTabId } = useEditorStore.getState();
          const activeTab = useEditorStore.getState().tabs.find((t) => t.id === activeTabId);
          if (activeTab?.profileId === profileId) {
            useConnectionStore.getState().setSelectedConnection(conn.id);
          }
        } catch (e) {
          // Cancelled from its placeholder tab: the user knows.
          if (e instanceof Error && e.message === "Connection cancelled") continue;
          // Leaving the tab without a live connection is right; saying nothing
          // about it is not. The tab looked normal and the first query failed
          // with "Connection not found", which describes neither what happened
          // nor when (#276).
          const name = useConnectionStore.getState().profiles.find((p) => p.id === profileId)?.name
            ?? profileId;
          failed.push(name);
          failedIds.push(profileId);
          console.warn(`Could not reconnect to ${name} on startup`, e);
        }
      }

      if (failed.length > 0) {
        useConnectionStore.setState({
          // One failure can offer Retry and Edit for its profile (#804).
          failedProfileId: failedIds.length === 1 ? failedIds[0] : null,
          error: failed.length === 1
            ? `Could not reconnect to ${failed[0]}. Its tabs have no live connection — use the connect button to retry.`
            : `Could not reconnect to ${failed.length} servers (${
              failed.join(", ")
            }). Their tabs have no live connection — use the connect button to retry.`,
        });
      }
    };
    init();
  }, []);
}
