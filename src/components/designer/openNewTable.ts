import { connectionKind } from "../../lib/datasource";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";

/**
 * Open the table designer on a new table, from the menu bar or the palette.
 *
 * The designer's create mode was unreachable: every route into it passed a
 * table name (#818). With no tree node to say which database, it uses the
 * one the status bar shows: the active tab's, or the connection's default.
 *
 * Returns what went wrong, if anything, so the caller can say so; a command
 * that silently does nothing looks broken.
 */
export function openNewTableDesigner(): string | null {
  const { selectedConnectionId, activeConnections } = useConnectionStore.getState();
  if (!selectedConnectionId) return "Connect to a server first.";
  // The designer writes MySQL DDL; a SQLite file has no use for it.
  if (connectionKind(selectedConnectionId) === "sqlite") {
    return "The table designer works on MySQL and MariaDB connections only.";
  }
  const editor = useEditorStore.getState();
  const tab = editor.tabs.find((t) => t.id === editor.activeTabId);
  const connection = activeConnections.find((c) => c.id === selectedConnectionId);
  const tabDatabase = tab?.connectionId === selectedConnectionId ? tab.database : undefined;
  const database = tabDatabase || connection?.database;
  if (!database) {
    return "Pick a database first, or right-click one in the tree and choose New Table….";
  }
  editor.addDesignerTab(selectedConnectionId, database);
  return null;
}
