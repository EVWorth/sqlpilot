import { useConnectionStore } from "../stores/connectionStore";
import { useSqliteStore } from "../stores/sqliteStore";
import type { EditorTab } from "../types";

/**
 * Every connection that can run a statement right now: the connected servers
 * and the open SQLite files.
 *
 * The one definition of "live" for code outside a component. Where a run goes
 * (`runConnectionId`) and whether a tab's own connection still counts
 * (`resultStore`, #944) have to agree on it, or a tab is left bound to a
 * connection Run no longer uses.
 */
export function liveConnectionIds(): string[] {
  return [
    ...useConnectionStore.getState().activeConnections.map((c) => c.id),
    ...useSqliteStore.getState().sessions.map((s) => s.id),
  ];
}

/**
 * Which connection Run sends the active tab's statements to.
 *
 * The tab's own connection when it is live, which is also what its colour and
 * production dot are drawn from (`EditorTabs`). Run used to take the globally
 * selected connection instead, so a tab marked as production could run on
 * dev and the reverse (#788). The selected connection is the answer only for a
 * tab that has no live connection of its own: a fresh tab, or one whose
 * server has gone — and such a tab carries no server markers either. Either
 * is bound to where that run went (`resultStore`, #942, #944), and from then
 * on runs there like any other.
 */
export function runConnectionId(
  tab: Pick<EditorTab, "connectionId"> | undefined,
  selectedConnectionId: string | null,
  liveConnectionIds: readonly string[],
): string | undefined {
  if (tab?.connectionId && liveConnectionIds.includes(tab.connectionId)) {
    return tab.connectionId;
  }
  return selectedConnectionId ?? undefined;
}
