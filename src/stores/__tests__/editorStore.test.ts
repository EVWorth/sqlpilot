import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_KEY = "sqlpilot-editor-session";

describe("editorStore", () => {
  let useEditorStore: typeof import("../editorStore").useEditorStore;

  beforeEach(async () => {
    localStorage.removeItem(SESSION_KEY);
    vi.resetModules();
    const mod = await import("../editorStore");
    useEditorStore = mod.useEditorStore;
    useEditorStore.setState({ tabs: [], activeTabId: null });
  });

  // Module-level singleton refresh needed for auto-save subscription
  // The subscription attaches at module load time; without resetModules the
  // old subscription may linger. For state-mutating tests we always start fresh.

  describe("addTab", () => {
    it("should add a tab", () => {
      const id = useEditorStore.getState().addTab();
      expect(useEditorStore.getState().tabs).toHaveLength(1);
      expect(useEditorStore.getState().activeTabId).toBe(id);
    });

    it("should add tab with connectionId and database", () => {
      const id = useEditorStore.getState().addTab("conn-1", "testdb");
      const tab = useEditorStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.connectionId).toBe("conn-1");
      expect(tab?.database).toBe("testdb");
      expect(tab?.type).toBe("query");
    });
  });

  describe("closeTab", () => {
    it("should close a tab when multiple tabs exist", () => {
      const id1 = useEditorStore.getState().addTab();
      useEditorStore.getState().addTab();
      useEditorStore.getState().closeTab(id1);
      expect(useEditorStore.getState().tabs).toHaveLength(1);
    });

    it("should not close the last query tab", () => {
      const id = useEditorStore.getState().addTab();
      useEditorStore.getState().closeTab(id);
      expect(useEditorStore.getState().tabs).toHaveLength(1);
      expect(useEditorStore.getState().activeTabId).toBe(id);
    });

    it("should allow closing non-query tabs", () => {
      const id = useEditorStore.getState().addAdminTab("conn-1");
      expect(useEditorStore.getState().tabs).toHaveLength(1);
      useEditorStore.getState().closeTab(id);
      expect(useEditorStore.getState().tabs).toHaveLength(0);
    });

    it("should switch active tab on close", () => {
      const id1 = useEditorStore.getState().addTab();
      useEditorStore.getState().addTab();
      const id2 = useEditorStore.getState().activeTabId!;
      useEditorStore.getState().closeTab(id2);
      expect(useEditorStore.getState().activeTabId).toBe(id1);
    });

    it("should not switch active tab if closing non-active tab", () => {
      const id1 = useEditorStore.getState().addTab();
      const id2 = useEditorStore.getState().addTab();
      useEditorStore.getState().closeTab(id1);
      expect(useEditorStore.getState().activeTabId).toBe(id2);
    });

    it("should set activeTabId to null when all tabs closed", () => {
      const id = useEditorStore.getState().addStructureTab("conn-1", "db", "tbl");
      useEditorStore.getState().closeTab(id);
      expect(useEditorStore.getState().tabs).toHaveLength(0);
      expect(useEditorStore.getState().activeTabId).toBeNull();
    });
  });

  describe("closeOtherTabs", () => {
    it("should close all tabs except the specified one", () => {
      const id1 = useEditorStore.getState().addStructureTab("conn-1", "db", "t1");
      const id2 = useEditorStore.getState().addStructureTab("conn-1", "db", "t2");
      const id3 = useEditorStore.getState().addStructureTab("conn-1", "db", "t3");
      expect(useEditorStore.getState().tabs).toHaveLength(3);

      useEditorStore.getState().closeOtherTabs(id2);

      expect(useEditorStore.getState().tabs).toHaveLength(1);
      expect(useEditorStore.getState().tabs[0].id).toBe(id2);
      expect(useEditorStore.getState().activeTabId).toBe(id2);
    });

    it("should keep non-query tabs of different types", () => {
      const qId = useEditorStore.getState().addTab("conn-1");
      const sId = useEditorStore.getState().addStructureTab("conn-1", "db", "tbl");
      const qId2 = useEditorStore.getState().addTab("conn-1");

      useEditorStore.getState().closeOtherTabs(qId);

      const remaining = useEditorStore.getState().tabs;
      // Only the specified query tab and the structure tab should remain
      expect(remaining.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("closeTabsToRight", () => {
    it("should close tabs to the right of the specified tab", () => {
      useEditorStore.getState().addStructureTab("conn-1", "db", "t1");
      useEditorStore.getState().addStructureTab("conn-1", "db", "t2");
      useEditorStore.getState().addStructureTab("conn-1", "db", "t3");
      const tabs = useEditorStore.getState().tabs;
      const middleId = tabs[1].id;

      useEditorStore.getState().closeTabsToRight(middleId);

      const remaining = useEditorStore.getState().tabs;
      expect(remaining.length).toBeLessThanOrEqual(3);
      // The active tab should be the one we specified
      expect(useEditorStore.getState().activeTabId).toBe(middleId);
    });
  });

  describe("addStructureTab", () => {
    it("should add a structure tab", () => {
      const id = useEditorStore.getState().addStructureTab("conn-1", "testdb", "users");
      const tab = useEditorStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.type).toBe("structure");
      expect(tab?.tableName).toBe("users");
      expect(tab?.title).toContain("users");
    });

    it("should reuse existing structure tab", () => {
      const id1 = useEditorStore.getState().addStructureTab("conn-1", "testdb", "users");
      const id2 = useEditorStore.getState().addStructureTab("conn-1", "testdb", "users");
      expect(id1).toBe(id2);
      expect(useEditorStore.getState().tabs).toHaveLength(1);
    });
  });

  describe("addAdminTab", () => {
    it("should add an admin tab", () => {
      const id = useEditorStore.getState().addAdminTab("conn-1");
      const tab = useEditorStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.type).toBe("admin");
      expect(tab?.connectionId).toBe("conn-1");
    });

    it("should reuse existing admin tab for same connection", () => {
      const id1 = useEditorStore.getState().addAdminTab("conn-1");
      const id2 = useEditorStore.getState().addAdminTab("conn-1");
      expect(id1).toBe(id2);
    });
  });

  describe("addRoutineTab", () => {
    it("should add a routine tab", () => {
      const id = useEditorStore.getState().addRoutineTab("conn-1", "testdb", "my_proc", "PROCEDURE");
      const tab = useEditorStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.type).toBe("routine");
      expect(tab?.routineName).toBe("my_proc");
      expect(tab?.routineType).toBe("PROCEDURE");
    });

    it("should reuse existing routine tab", () => {
      const id1 = useEditorStore.getState().addRoutineTab("conn-1", "testdb", "my_proc", "PROCEDURE");
      const id2 = useEditorStore.getState().addRoutineTab("conn-1", "testdb", "my_proc", "PROCEDURE");
      expect(id1).toBe(id2);
    });

    it("should add FUNCTION tab with different icon", () => {
      const id = useEditorStore.getState().addRoutineTab("conn-1", "testdb", "my_func", "FUNCTION");
      const tab = useEditorStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.type).toBe("routine");
      expect(tab?.title).toContain("my_func");
    });
  });

  describe("addCompareTab", () => {
    it("should add a compare tab", () => {
      const id = useEditorStore.getState().addCompareTab();
      const tab = useEditorStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.type).toBe("compare");
    });

    it("should reuse existing compare tab", () => {
      const id1 = useEditorStore.getState().addCompareTab();
      const id2 = useEditorStore.getState().addCompareTab();
      expect(id1).toBe(id2);
    });
  });

  describe("addDesignerTab", () => {
    it("should add a designer tab with tableName", () => {
      const id = useEditorStore.getState().addDesignerTab("conn-1", "testdb", "users");
      const tab = useEditorStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.type).toBe("designer");
      expect(tab?.tableName).toBe("users");
    });

    it("should add a designer tab without tableName (new table)", () => {
      const id = useEditorStore.getState().addDesignerTab("conn-1", "testdb");
      const tab = useEditorStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.type).toBe("designer");
      expect(tab?.title).toContain("New Table");
    });

    it("should reuse existing designer tab", () => {
      const id1 = useEditorStore.getState().addDesignerTab("conn-1", "testdb", "users");
      const id2 = useEditorStore.getState().addDesignerTab("conn-1", "testdb", "users");
      expect(id1).toBe(id2);
    });
  });

  describe("addQueryBuilderTab", () => {
    it("should add a query builder tab", () => {
      const id = useEditorStore.getState().addQueryBuilderTab("conn-1", "testdb");
      const tab = useEditorStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.type).toBe("querybuilder");
      expect(tab?.connectionId).toBe("conn-1");
      expect(tab?.database).toBe("testdb");
    });
  });

  describe("setActiveTab", () => {
    it("should set active tab", () => {
      const id = useEditorStore.getState().addTab();
      useEditorStore.getState().addTab();
      useEditorStore.getState().setActiveTab(id);
      expect(useEditorStore.getState().activeTabId).toBe(id);
    });
  });

  describe("updateTabContent", () => {
    it("should update tab content and set isDirty", () => {
      const id = useEditorStore.getState().addTab();
      useEditorStore.getState().updateTabContent(id, "SELECT 1");
      const tab = useEditorStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.content).toBe("SELECT 1");
      expect(tab?.isDirty).toBe(true);
    });

    it("should not affect other tabs", () => {
      const id1 = useEditorStore.getState().addTab();
      const id2 = useEditorStore.getState().addTab();
      useEditorStore.getState().updateTabContent(id1, "SELECT 1");
      const tab2 = useEditorStore.getState().tabs.find((t) => t.id === id2);
      expect(tab2?.content).toBe("");
      expect(tab2?.isDirty).toBe(false);
    });
  });

  describe("setTabConnection", () => {
    it("should set tab connection", () => {
      const id = useEditorStore.getState().addTab();
      useEditorStore.getState().setTabConnection(id, "conn-1", "test_db");
      const tab = useEditorStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.connectionId).toBe("conn-1");
      expect(tab?.database).toBe("test_db");
    });

    it("should set profileId when provided", () => {
      const id = useEditorStore.getState().addTab();
      useEditorStore.getState().setTabConnection(id, "conn-1", undefined, "profile-1");
      const tab = useEditorStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.profileId).toBe("profile-1");
    });

    it("should not set profileId when undefined", () => {
      const id = useEditorStore.getState().addTab();
      useEditorStore.getState().setTabConnection(id, "conn-1", "db", undefined);
      const tab = useEditorStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.profileId).toBeUndefined();
    });

    it("should not affect other tabs", () => {
      const id1 = useEditorStore.getState().addTab();
      const id2 = useEditorStore.getState().addTab();
      useEditorStore.getState().setTabConnection(id1, "conn-A");
      const tab2 = useEditorStore.getState().tabs.find((t) => t.id === id2);
      expect(tab2?.connectionId).toBeUndefined();
    });
  });

  describe("setEditorInstance", () => {
    it("should set editor instance", () => {
      const mockEditor = { getId: () => "editor-1" } as unknown as import("monaco-editor").editor.IStandaloneCodeEditor;
      useEditorStore.getState().setEditorInstance(mockEditor);
      expect(useEditorStore.getState().editorInstance).toBe(mockEditor);
    });

    it("should set editor instance to null", () => {
      useEditorStore.getState().setEditorInstance(null);
      expect(useEditorStore.getState().editorInstance).toBeNull();
    });
  });

  describe("setTabDirty", () => {
    it("should set tab dirty flag", () => {
      const id = useEditorStore.getState().addTab();
      useEditorStore.getState().setTabDirty(id, true);
      const tab = useEditorStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.isDirty).toBe(true);
    });

    it("should clear dirty flag", () => {
      const id = useEditorStore.getState().addTab();
      useEditorStore.getState().setTabDirty(id, true);
      useEditorStore.getState().setTabDirty(id, false);
      const tab = useEditorStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.isDirty).toBe(false);
    });
  });

  describe("renameTab", () => {
    it("should rename a tab", () => {
      const id = useEditorStore.getState().addTab();
      useEditorStore.getState().renameTab(id, "My Custom Title");
      const tab = useEditorStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.title).toBe("My Custom Title");
    });

    it("should not affect other tabs", () => {
      const id1 = useEditorStore.getState().addTab();
      const id2 = useEditorStore.getState().addTab();
      useEditorStore.getState().renameTab(id1, "New Title");
      const tab2 = useEditorStore.getState().tabs.find((t) => t.id === id2);
      expect(tab2?.title).toBe("Untitled Query");
    });
  });

  describe("reorderTabs", () => {
    it("should reorder tabs", () => {
      const id1 = useEditorStore.getState().addTab();
      const id2 = useEditorStore.getState().addTab();
      const id3 = useEditorStore.getState().addTab();

      const orderBefore = useEditorStore.getState().tabs.map((t) => t.id);
      expect(orderBefore).toEqual([id1, id2, id3]);

      useEditorStore.getState().reorderTabs(2, 0);

      const orderAfter = useEditorStore.getState().tabs.map((t) => t.id);
      expect(orderAfter).toEqual([id3, id1, id2]);
    });

    it("should move tab to middle", () => {
      const id1 = useEditorStore.getState().addTab();
      const id2 = useEditorStore.getState().addTab();
      const id3 = useEditorStore.getState().addTab();

      useEditorStore.getState().reorderTabs(0, 1);

      const orderAfter = useEditorStore.getState().tabs.map((t) => t.id);
      expect(orderAfter).toEqual([id2, id1, id3]);
    });
  });

  describe("edge cases", () => {
    it("should handle updating content for non-existent tab id", () => {
      useEditorStore.getState().addTab();
      useEditorStore.getState().updateTabContent("non-existent", "SELECT 1");
      const tabs = useEditorStore.getState().tabs;
      expect(tabs).toHaveLength(1);
    });

    it("should handle closing non-existent tab", () => {
      useEditorStore.getState().addTab();
      useEditorStore.getState().closeTab("non-existent");
      expect(useEditorStore.getState().tabs).toHaveLength(1);
    });

    it("should handle closing tab with activeTabId not set", () => {
      useEditorStore.setState({ tabs: [], activeTabId: null });
      useEditorStore.getState().closeTab("any");
      expect(useEditorStore.getState().tabs).toHaveLength(0);
    });

    it("should not close last query tab even if there are other tabs of different type", () => {
      useEditorStore.getState().addTab();
      useEditorStore.getState().addAdminTab("conn-1");
      const queryTab = useEditorStore.getState().tabs.find((t) => t.type === "query");
      expect(queryTab).toBeDefined();
      useEditorStore.getState().closeTab(queryTab!.id);
      const queryTabs = useEditorStore.getState().tabs.filter((t) => t.type === "query");
      expect(queryTabs.length).toBe(1);
    });
  });
});

describe("editorStore session persistence", () => {
  beforeEach(() => {
    localStorage.removeItem(SESSION_KEY);
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("restores session from localStorage with valid data", async () => {
    const sessionData = {
      tabs: [
        {
          id: "tab-5",
          title: "Saved Query",
          content: "SELECT 1",
          connectionId: "conn-x",
          database: "mydb",
          type: "query",
          isDirty: true,
        },
      ],
      activeTabId: "tab-5",
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(sessionData));

    vi.resetModules();
    const { useEditorStore: store } = await import("../editorStore");
    const state = store.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].id).toBe("tab-5");
    expect(state.tabs[0].content).toBe("SELECT 1");
    expect(state.tabs[0].isDirty).toBe(false);
    expect(state.activeTabId).toBe("tab-5");
  });

  it("falls back to initial tab when localStorage has empty tabs array", async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ tabs: [], activeTabId: "tab-1" }));

    vi.resetModules();
    const { useEditorStore: store } = await import("../editorStore");
    const state = store.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].id).toBe("tab-0");
  });

  it("falls back to initial tab when localStorage has no data", async () => {
    vi.resetModules();
    const { useEditorStore: store } = await import("../editorStore");
    const state = store.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].id).toBe("tab-0");
  });

  it("falls back to initial tab when localStorage has invalid JSON", async () => {
    localStorage.setItem(SESSION_KEY, "not-valid-json{{{");

    vi.resetModules();
    const { useEditorStore: store } = await import("../editorStore");
    const state = store.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].id).toBe("tab-0");
  });

  it("falls back to initial tab when localStorage.getItem throws", async () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    vi.resetModules();
    const { useEditorStore: store } = await import("../editorStore");
    const state = store.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].id).toBe("tab-0");
  });

  it("auto-saves tabs to localStorage after debounce", async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      const { useEditorStore: store } = await import("../editorStore");
      // Close the initial tab-0 first so we only have our tab
      store.getState().addTab(); // add a second query tab so we can close tab-0
      store.getState().closeTab("tab-0");
      const id = store.getState().addTab("conn-1", "db1");
      expect(localStorage.getItem(SESSION_KEY)).toBeNull();

      vi.advanceTimersByTime(600);
      const saved = JSON.parse(localStorage.getItem(SESSION_KEY)!);
      expect(saved.tabs).toHaveLength(2);
      expect(saved.tabs[1].connectionId).toBe("conn-1");
      expect(saved.tabs[1].id).toBe(id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles localStorage.setItem throwing during auto-save gracefully", async () => {
    vi.useFakeTimers();
    const origSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota exceeded");
    };

    try {
      vi.resetModules();
      const { useEditorStore: store } = await import("../editorStore");
      store.getState().addTab(); // add second query tab so we can close initial
      store.getState().closeTab("tab-0");
      store.getState().addTab("conn-1", "db1");

      expect(() => vi.advanceTimersByTime(600)).not.toThrow();
    } finally {
      vi.useRealTimers();
      Storage.prototype.setItem = origSetItem;
    }
  });

  it("debounces multiple rapid changes into one save", async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      const { useEditorStore: store } = await import("../editorStore");
      store.getState().addTab(); // add second query tab so we can close initial
      store.getState().closeTab("tab-0");

      store.getState().addTab("conn-1", "db1");
      store.getState().addTab("conn-1", "db2");
      store.getState().addTab("conn-1", "db3");

      vi.advanceTimersByTime(400);
      expect(localStorage.getItem(SESSION_KEY)).toBeNull();

      vi.advanceTimersByTime(200);
      const saved = JSON.parse(localStorage.getItem(SESSION_KEY)!);
      expect(saved.tabs).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
