import { useConnectionStore } from "../stores/connectionStore";
import { useEditorStore } from "../stores/editorStore";
import type { EditorTab } from "../types";
import { api } from "./tauri-api";

/**
 * Each editor tab's own server session, and when to end it (#731).
 *
 * A tab's statements run on a connection the tab keeps, so what one run sets
 * up — `SET @var`, a temporary table, a transaction begun and not yet
 * committed — is there for the next, as in any other client. The backend opens
 * the session on the tab's first statement; ending it is this module's job,
 * because only the frontend knows when a tab has gone.
 *
 * One subscription on the editor store rather than a call in every close path:
 * a tab disappears through Close, Close Others, Close to the Right and the
 * replacement that closing the last tab makes, and it can be pointed at
 * another connection from the schema tree or the connection bar. Watching the
 * result covers all of them, including ones added later.
 *
 * Not to be confused with `editor-session.ts`, which saves the tab layout.
 */

/** Tab id → the connections that tab has opened a session on. */
const open = new Map<string, Set<string>>();

/** Record that a tab's statement ran on its session for this connection. */
export function noteSession(tabId: string, connectionId: string) {
  const connections = open.get(tabId) ?? new Set<string>();
  connections.add(connectionId);
  open.set(tabId, connections);
  watchTabs();
}

/**
 * Which sessions no tab can use any more.
 *
 * A session goes when its tab has closed, or when the tab now points at a
 * different connection. The selected connection is spared even then: the
 * editor runs on the selection, and a statement can be in flight on it while
 * the tab's own field catches up.
 */
export function sessionsToClose(
  sessions: ReadonlyMap<string, ReadonlySet<string>>,
  tabs: readonly Pick<EditorTab, "id" | "connectionId">[],
  selectedConnectionId: string | null,
): { tabId: string; connectionId: string }[] {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const stale: { tabId: string; connectionId: string }[] = [];
  for (const [tabId, connections] of sessions) {
    const tab = byId.get(tabId);
    for (const connectionId of connections) {
      const tabGone = !tab;
      const tabMoved = tab?.connectionId !== undefined
        && tab.connectionId !== connectionId
        && connectionId !== selectedConnectionId;
      if (tabGone || tabMoved) stale.push({ tabId, connectionId });
    }
  }
  return stale;
}

function closeStale() {
  const stale = sessionsToClose(
    open,
    useEditorStore.getState().tabs,
    useConnectionStore.getState().selectedConnectionId,
  );
  for (const { tabId, connectionId } of stale) {
    const connections = open.get(tabId);
    connections?.delete(connectionId);
    if (connections?.size === 0) open.delete(tabId);
    // A connection already gone has taken its sessions with it; nothing here
    // is worth interrupting the user over.
    void api.closeSession(connectionId, tabId).catch((e) => {
      console.warn(`Could not close the session for ${tabId} on ${connectionId}`, e);
    });
  }
}

let watching = false;

/**
 * Start watching the tabs, once, when the first session opens.
 *
 * Not at import: until a tab has a session there is nothing to close, and a
 * module that reads the stores as it loads makes every importer depend on them
 * being ready — which in tests, where they are mocked, they are not.
 */
function watchTabs() {
  if (watching) return;
  watching = true;
  let lastTabs = useEditorStore.getState().tabs;
  useEditorStore.subscribe((state) => {
    if (state.tabs === lastTabs) return;
    lastTabs = state.tabs;
    closeStale();
  });
}
