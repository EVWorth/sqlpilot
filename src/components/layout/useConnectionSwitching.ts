import { useEffect } from "react";
import { runConnectionId } from "../../lib/run-connection";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { useSqliteStore } from "../../stores/sqliteStore";
import type { ConnectionInfo } from "../../types";

/** Every connection that can run a statement right now. */
function liveConnectionIds(): string[] {
  return [
    ...useConnectionStore.getState().activeConnections.map((c) => c.id),
    ...useSqliteStore.getState().sessions.map((s) => s.id),
  ];
}

/**
 * Keep the selected connection and the active editor tab pointing at the
 * same server (#788).
 *
 * The editor tab's colour and production dot come from the tab's own
 * connection, Run follows it too (`runConnectionId`), and the toolbar and
 * status bar show the selected one. Those used to drift: connecting a second
 * server silently re-pointed the open tab, and clicking a connection tab
 * changed what the toolbar said without changing the editor tab. Here:
 *
 * - switching editor tabs selects that tab's connection;
 * - selecting a connection moves to one of its editor tabs, or opens one;
 * - connecting a new server opens a tab for it, unless the active tab has
 *   no server yet, in which case that tab takes it.
 */
export function useConnectionSwitching() {
  const activeTabConnectionId = useEditorStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId)?.connectionId,
  );
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const sqliteSessions = useSqliteStore((s) => s.sessions);
  const setSelectedConnection = useConnectionStore((s) => s.setSelectedConnection);

  useEffect(() => {
    if (!activeTabConnectionId) return;
    if (!liveConnectionIds().includes(activeTabConnectionId)) return;
    if (useConnectionStore.getState().selectedConnectionId === activeTabConnectionId) return;
    setSelectedConnection(activeTabConnectionId);
  }, [activeTabConnectionId, activeConnections, sqliteSessions, setSelectedConnection]);

  /** Open a query tab on `conn`, carrying its profile for reconnects. */
  const openTabFor = (connectionId: string, conn?: ConnectionInfo) => {
    const { addTab, setTabConnection } = useEditorStore.getState();
    const database = conn?.database ?? undefined;
    const tabId = addTab(connectionId, database);
    if (conn) setTabConnection(tabId, connectionId, database, conn.profile_id);
  };

  /** A connection tab was clicked. */
  const selectConnection = (connectionId: string) => {
    setSelectedConnection(connectionId);
    const { tabs, activeTabId, setActiveTab } = useEditorStore.getState();
    const active = tabs.find((t) => t.id === activeTabId);
    // Already where Run would go: a tab on this server, or one with none.
    if (!active || runConnectionId(active, connectionId, liveConnectionIds()) === connectionId) return;

    const existing = tabs.find((t) => t.type === "query" && t.connectionId === connectionId)
      ?? tabs.find((t) => t.connectionId === connectionId);
    if (existing) {
      setActiveTab(existing.id);
      return;
    }
    const conn = useConnectionStore.getState().activeConnections.find((c) => c.id === connectionId);
    openTabFor(connectionId, conn);
  };

  /** A new connection has just been made from the connect menu. */
  const attachNewConnection = (conn: ConnectionInfo) => {
    const { tabs, activeTabId, setTabConnection } = useEditorStore.getState();
    const active = tabs.find((t) => t.id === activeTabId);
    const activeHasServer = !!active?.connectionId
      && active.connectionId !== conn.id
      && liveConnectionIds().includes(active.connectionId);
    if (active && !activeHasServer) {
      setTabConnection(active.id, conn.id, conn.database ?? undefined, conn.profile_id);
      return;
    }
    openTabFor(conn.id, conn);
  };

  return { selectConnection, attachNewConnection };
}
