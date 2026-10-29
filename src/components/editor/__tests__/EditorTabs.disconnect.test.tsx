import { render, screen } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const disconnect = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/tauri-api", () => ({ api: { disconnect } }));

import { useConnectionStore } from "../../../stores/connectionStore";
import { useEditorStore } from "../../../stores/editorStore";
import { useTransactionStore } from "../../../stores/transactionStore";
import { EditorTabs } from "../EditorTabs";

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = vi.fn();

/**
 * The tab's TX badge against the real stores: BEGIN, then disconnect (#910).
 *
 * Closing the connection ends the tab's session, and the server rolls back
 * what it had open. The badge stayed, saying work was pending that was gone.
 */
describe("the open-transaction badge across a disconnect (#910)", () => {
  beforeEach(() => {
    disconnect.mockReset().mockResolvedValue(undefined);
    useConnectionStore.setState({
      activeConnections: [{
        id: "conn-1",
        profile_id: "prof-1",
        name: "Test DB",
        host: "localhost",
        port: 3306,
        database: null,
        server_version: "8.0.33",
        connected_at: "2024-01-01T00:00:00Z",
        color: null,
        environment: null,
      }],
      profiles: [],
      selectedConnectionId: "conn-1",
    });
    useEditorStore.setState({
      tabs: [{
        id: "tab-a",
        title: "Query 1",
        content: "BEGIN",
        type: "query",
        isDirty: false,
        connectionId: "conn-1",
      }],
      activeTabId: "tab-a",
      pendingClose: null,
    });
    // What running BEGIN on the tab's session records (#843).
    useTransactionStore.setState({ open: { "tab-a": true } });
  });

  it("drops the badge when the connection closes", async () => {
    render(<EditorTabs />);
    expect(screen.getByText(", transaction open")).toBeInTheDocument();

    await act(() => useConnectionStore.getState().disconnect("conn-1"));

    expect(disconnect).toHaveBeenCalledWith("conn-1");
    expect(screen.queryByText(", transaction open")).not.toBeInTheDocument();
  });
});
