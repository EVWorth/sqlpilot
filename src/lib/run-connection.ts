import type { EditorTab } from "../types";

/**
 * Which connection Run sends the active tab's statements to.
 *
 * The tab's own connection when it is live, which is also what its colour and
 * production dot are drawn from (`EditorTabs`). Run used to take the globally
 * selected connection instead, so a tab marked as production could run on
 * dev and the reverse (#788). The selected connection is the answer only for a
 * tab that has no live connection of its own: a fresh tab, or one whose
 * server has gone — and such a tab carries no server markers either. A fresh
 * tab is bound to where its first run went (`resultStore`, #942), and from
 * then on runs there like any other.
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
