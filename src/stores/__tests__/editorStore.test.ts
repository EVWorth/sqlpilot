import { describe, it, expect, beforeEach } from "vitest";
import { useEditorStore } from "../editorStore";

describe("editorStore", () => {
  beforeEach(() => {
    useEditorStore.setState({ tabs: [], activeTabId: null });
  });

  it("should add a tab", () => {
    const id = useEditorStore.getState().addTab();
    expect(useEditorStore.getState().tabs).toHaveLength(1);
    expect(useEditorStore.getState().activeTabId).toBe(id);
  });

  it("should close a tab", () => {
    const id = useEditorStore.getState().addTab();
    useEditorStore.getState().closeTab(id);
    expect(useEditorStore.getState().tabs).toHaveLength(0);
    expect(useEditorStore.getState().activeTabId).toBeNull();
  });

  it("should switch active tab on close", () => {
    const id1 = useEditorStore.getState().addTab();
    useEditorStore.getState().addTab();
    const id2 = useEditorStore.getState().activeTabId!;
    useEditorStore.getState().closeTab(id2);
    expect(useEditorStore.getState().activeTabId).toBe(id1);
  });

  it("should update tab content", () => {
    const id = useEditorStore.getState().addTab();
    useEditorStore.getState().updateTabContent(id, "SELECT 1");
    const tab = useEditorStore.getState().tabs.find((t) => t.id === id);
    expect(tab?.content).toBe("SELECT 1");
    expect(tab?.isDirty).toBe(true);
  });

  it("should set tab connection", () => {
    const id = useEditorStore.getState().addTab();
    useEditorStore.getState().setTabConnection(id, "conn-1", "test_db");
    const tab = useEditorStore.getState().tabs.find((t) => t.id === id);
    expect(tab?.connectionId).toBe("conn-1");
    expect(tab?.database).toBe("test_db");
  });
});
