import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useEditorStore } from "../../../stores/editorStore";
import type { ConnectionInfo } from "../../../types";
import { useConnectionSwitching } from "../useConnectionSwitching";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const dev = { id: "dev", profile_id: "p-dev", database: "app" } as unknown as ConnectionInfo;
const prod = { id: "prod", profile_id: "p-prod", database: "shop" } as unknown as ConnectionInfo;

function setConnections(active: ConnectionInfo[], selected: string | null) {
  useConnectionStore.setState({ activeConnections: active, selectedConnectionId: selected });
}

function activeTab() {
  const { tabs, activeTabId } = useEditorStore.getState();
  return tabs.find((t) => t.id === activeTabId);
}

beforeEach(() => {
  useEditorStore.setState({
    tabs: [{
      id: "tab-0",
      title: "Untitled Query",
      content: "",
      type: "query",
      isDirty: false,
      connectionId: "dev",
      profileId: "p-dev",
    }],
    activeTabId: "tab-0",
  });
  setConnections([dev], "dev");
});

describe("editor tab and selected connection agree (#788)", () => {
  it("opens a new tab for a new server instead of re-pointing the open one", () => {
    const { result } = renderHook(() => useConnectionSwitching());
    setConnections([dev, prod], "prod");

    act(() => result.current.attachNewConnection(prod));

    const original = useEditorStore.getState().tabs.find((t) => t.id === "tab-0");
    expect(original?.connectionId).toBe("dev");
    expect(activeTab()?.connectionId).toBe("prod");
    expect(activeTab()?.profileId).toBe("p-prod");
  });

  it("gives the new server to a tab that has none yet", () => {
    useEditorStore.setState({
      tabs: [{ id: "tab-0", title: "Untitled Query", content: "", type: "query", isDirty: false }],
      activeTabId: "tab-0",
    });
    setConnections([], null);
    const { result } = renderHook(() => useConnectionSwitching());
    setConnections([prod], "prod");

    act(() => result.current.attachNewConnection(prod));

    expect(useEditorStore.getState().tabs).toHaveLength(1);
    expect(activeTab()?.connectionId).toBe("prod");
  });

  it("moves to the clicked connection's editor tab", () => {
    const { result } = renderHook(() => useConnectionSwitching());
    setConnections([dev, prod], "prod");
    act(() => result.current.attachNewConnection(prod));
    expect(activeTab()?.connectionId).toBe("prod");

    act(() => result.current.selectConnection("dev"));

    expect(useConnectionStore.getState().selectedConnectionId).toBe("dev");
    expect(activeTab()?.id).toBe("tab-0");
  });

  it("opens a tab for a clicked connection that has none", () => {
    setConnections([dev, prod], "dev");
    const { result } = renderHook(() => useConnectionSwitching());

    act(() => result.current.selectConnection("prod"));

    expect(useConnectionStore.getState().selectedConnectionId).toBe("prod");
    expect(activeTab()?.connectionId).toBe("prod");
    expect(useEditorStore.getState().tabs.find((t) => t.id === "tab-0")?.connectionId).toBe("dev");
  });

  it("selects the connection of the editor tab switched to", () => {
    setConnections([dev, prod], "dev");
    const { result } = renderHook(() => useConnectionSwitching());
    act(() => result.current.selectConnection("prod"));
    const prodTab = activeTab()?.id ?? "";

    act(() => useEditorStore.getState().setActiveTab("tab-0"));
    expect(useConnectionStore.getState().selectedConnectionId).toBe("dev");

    act(() => useEditorStore.getState().setActiveTab(prodTab));
    expect(useConnectionStore.getState().selectedConnectionId).toBe("prod");
  });
});
