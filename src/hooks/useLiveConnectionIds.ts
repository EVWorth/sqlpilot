import { useMemo } from "react";
import { useConnectionStore } from "../stores/connectionStore";
import { useSqliteStore } from "../stores/sqliteStore";

/**
 * Every connection that can run a statement right now, for a component: the
 * connected servers and the open SQLite files.
 *
 * `liveConnectionIds` (lib/run-connection) is the same list read once, for
 * code outside a component. This one re-renders its caller when a server
 * connects or disconnects or a file opens or closes. Both have to stay the
 * same list: where a run goes and whether a tab's connection still counts
 * (#944) depend on it.
 */
export function useLiveConnectionIds(): string[] {
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const sqliteSessions = useSqliteStore((s) => s.sessions);
  return useMemo(
    () => [...activeConnections.map((c) => c.id), ...sqliteSessions.map((s) => s.id)],
    [activeConnections, sqliteSessions],
  );
}
