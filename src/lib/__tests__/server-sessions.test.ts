import { beforeEach, describe, expect, it, vi } from "vitest";

const closeSessionMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../tauri-api", () => ({
  api: { closeSession: (...args: unknown[]) => closeSessionMock(...args) },
}));

import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { noteSession, sessionsToClose } from "../server-sessions";

/** A session table the way `noteSession` builds it. */
function sessions(entries: Record<string, string[]>) {
  return new Map(Object.entries(entries).map(([tab, conns]) => [tab, new Set(conns)]));
}

describe("sessionsToClose", () => {
  it("keeps a session whose tab is still open on that connection", () => {
    expect(
      sessionsToClose(sessions({ "tab-1": ["conn-a"] }), [{ id: "tab-1", connectionId: "conn-a" }], "conn-a"),
    ).toEqual([]);
  });

  it("closes every session of a tab that has gone", () => {
    // Closing the connection is what ends the server session, and with it
    // any transaction the tab left open — as closing a tab does anywhere.
    expect(
      sessionsToClose(sessions({ "tab-1": ["conn-a", "conn-b"] }), [], null),
    ).toEqual([
      { tabId: "tab-1", connectionId: "conn-a" },
      { tabId: "tab-1", connectionId: "conn-b" },
    ]);
  });

  it("closes a tab's session on a connection it no longer points at", () => {
    expect(
      sessionsToClose(sessions({ "tab-1": ["conn-a"] }), [{ id: "tab-1", connectionId: "conn-b" }], "conn-b"),
    ).toEqual([{ tabId: "tab-1", connectionId: "conn-a" }]);
  });

  it("spares the selected connection while the tab catches up to it", () => {
    // The editor runs on the selection. A statement can be in flight there
    // while the tab's own field still names the previous connection.
    expect(
      sessionsToClose(sessions({ "tab-1": ["conn-a"] }), [{ id: "tab-1", connectionId: "conn-b" }], "conn-a"),
    ).toEqual([]);
  });

  it("leaves a tab with no connection of its own alone", () => {
    expect(
      sessionsToClose(sessions({ "tab-1": ["conn-a"] }), [{ id: "tab-1", connectionId: undefined }], null),
    ).toEqual([]);
  });
});

describe("closing a tab", () => {
  beforeEach(() => {
    closeSessionMock.mockClear();
    useEditorStore.setState({ tabs: [], activeTabId: null });
    useConnectionStore.setState(
      { selectedConnectionId: "conn-a" } as Parameters<typeof useConnectionStore.setState>[0],
    );
  });

  it("ends the session the tab opened", () => {
    const first = useEditorStore.getState().addTab("conn-a");
    const second = useEditorStore.getState().addTab("conn-a");
    noteSession(second, "conn-a");

    useEditorStore.getState().closeTab(second);

    expect(closeSessionMock).toHaveBeenCalledWith("conn-a", second);
    expect(closeSessionMock).not.toHaveBeenCalledWith("conn-a", first);
  });

  it("does not end a session when some other tab closes", () => {
    const keep = useEditorStore.getState().addTab("conn-a");
    const other = useEditorStore.getState().addTab("conn-a");
    noteSession(keep, "conn-a");

    useEditorStore.getState().closeTab(other);

    expect(closeSessionMock).not.toHaveBeenCalled();
  });

  it("ends it once, not again on every later change", () => {
    useEditorStore.getState().addTab("conn-a");
    const closing = useEditorStore.getState().addTab("conn-a");
    noteSession(closing, "conn-a");

    useEditorStore.getState().closeTab(closing);
    useEditorStore.getState().addTab("conn-a");

    // Counted for this tab only: the table is module state, so a session an
    // earlier test left behind is closed here too when the tabs are reset.
    const forThisTab = closeSessionMock.mock.calls.filter(([, tab]) => tab === closing);
    expect(forThisTab).toHaveLength(1);
  });
});
