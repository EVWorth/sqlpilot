import { useEffect } from "react";
import { runConnectionId } from "../lib/run-connection";
import { useConnectionStore } from "../stores/connectionStore";
import { useEditorStore } from "../stores/editorStore";
import { useResultStore } from "../stores/resultStore";
import { useSqliteStore } from "../stores/sqliteStore";

/**
 * Keep a grid read on one server from being shown under another (#842).
 *
 * Which tab's results are shown follows the editor's active tab inside the
 * result store itself. What is left here is the connection check: when the
 * shown tab's connection changes — a second server connected and selected, or
 * the tab shown is bound to a different one — results read elsewhere are
 * cleared rather than left under the new connection's name with Edit Mode
 * offered.
 */
export function useResultsFollowActiveTab() {
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const tabs = useEditorStore((s) => s.tabs);
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId);
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const sqliteSessions = useSqliteStore((s) => s.sessions);
  const dropForeignResults = useResultStore((s) => s.dropForeignResults);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  // The tab's own server, as Run would pick it (#788).
  const tabConnectionId = runConnectionId(activeTab, selectedConnectionId, [
    ...activeConnections.map((c) => c.id),
    ...sqliteSessions.map((s) => s.id),
  ]);

  useEffect(() => {
    dropForeignResults(tabConnectionId);
  }, [activeTabId, tabConnectionId, dropForeignResults]);
}
