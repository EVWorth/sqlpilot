import type { editor } from "monaco-editor";
import { create } from "zustand";
import { loadSession, maxTabCounter, saveSession } from "../lib/editor-session";
import { buildTab, findOpenTab, type TabKind, type TabParams } from "../lib/tab-kinds";
import type { EditorTab, RoutineKind } from "../types";

interface EditorState {
  tabs: EditorTab[];
  activeTabId: string | null;
  editorInstance: editor.IStandaloneCodeEditor | null;

  /** Open a tab of any kind, or activate the one already open for it. */
  openTab: <K extends TabKind>(kind: K, params: TabParams[K]) => string;
  addTab: (connectionId?: string, database?: string) => string;
  addStructureTab: (connectionId: string, database: string, tableName: string) => string;
  addAdminTab: (connectionId: string) => string;
  addRoutineTab: (
    connectionId: string,
    database: string,
    routineName: string,
    routineType: RoutineKind,
  ) => string;
  addDesignerTab: (connectionId: string, database: string, tableName?: string) => string;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  closeTabsToRight: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTabContent: (id: string, content: string) => void;
  setTabConnection: (
    id: string,
    connectionId: string,
    database?: string,
    profileId?: string,
  ) => void;
  setEditorInstance: (instance: editor.IStandaloneCodeEditor | null) => void;
  setTabDirty: (tabId: string, dirty: boolean) => void;
  renameTab: (tabId: string, newTitle: string) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
}

const restoredSession = loadSession();

let tabCounter = restoredSession ? maxTabCounter(restoredSession.tabs) : 0;

const initialTab: EditorTab = {
  id: "tab-0",
  title: "Untitled Query",
  content: "",
  connectionId: undefined,
  database: undefined,
  type: "query",
  isDirty: false,
};

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: restoredSession?.tabs ?? [initialTab],
  activeTabId: restoredSession?.activeTabId ?? "tab-0",
  editorInstance: null,

  /**
   * Open a tab of any kind, or activate the one already open for it.
   *
   * The five `add*Tab` methods below are this with their arguments named; each
   * used to carry its own copy of the find-or-create shape (#286).
   */
  openTab: (kind, params) => {
    const existing = findOpenTab(get().tabs, kind, params);
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    tabCounter++;
    const tab = buildTab(`tab-${tabCounter}`, kind, params);
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
    return tab.id;
  },

  addTab: (connectionId, database) => get().openTab("query", { connectionId, database }),

  addStructureTab: (connectionId, database, tableName) =>
    get().openTab("structure", { connectionId, database, tableName }),

  addRoutineTab: (connectionId, database, routineName, routineType) =>
    get().openTab("routine", { connectionId, database, routineName, routineType }),

  addAdminTab: (connectionId) => get().openTab("admin", { connectionId }),

  addDesignerTab: (connectionId, database, tableName) =>
    get().openTab("designer", { connectionId, database, tableName }),

  closeTab: (id) => {
    set((state) => {
      const tabToClose = state.tabs.find((t) => t.id === id);
      // If it's the last query tab, replace it with an empty one instead
      if (tabToClose?.type === "query") {
        const queryTabs = state.tabs.filter((t) => t.type === "query");
        if (queryTabs.length <= 1) {
          const newTab = {
            id: crypto.randomUUID(),
            title: `Query ${queryTabs.length + 1}`,
            content: "",
            type: "query" as const,
            isDirty: false,
          };
          return {
            tabs: state.tabs.map((t) => (t.id === id ? newTab : t)),
            activeTabId: newTab.id,
          };
        }
      }
      const newTabs = state.tabs.filter((t) => t.id !== id);
      const newActiveId = state.activeTabId === id
        ? newTabs.length > 0
          ? newTabs[newTabs.length - 1].id
          : null
        : state.activeTabId;
      return { tabs: newTabs, activeTabId: newActiveId };
    });
  },

  closeOtherTabs: (id) => {
    set((state) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) return state;
      // Keep only this tab and non-query tabs (structure, admin, etc.)
      const newTabs = state.tabs.filter(
        (t) => t.id === id || t.type !== tab.type,
      );
      return { tabs: newTabs, activeTabId: id };
    });
  },

  closeTabsToRight: (id) => {
    set((state) => {
      const idx = state.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return state;
      const tab = state.tabs[idx];
      // Close all tabs of same type to the right
      const newTabs = state.tabs.filter(
        (t, i) =>
          i <= idx
          || t.type !== tab.type
          || t.type === "query" && state.tabs.filter((x) => x.type === "query").length <= 2,
      );
      return { tabs: newTabs, activeTabId: id };
    });
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  updateTabContent: (id, content) => {
    set((state) => ({
      tabs: state.tabs.map((t) => t.id === id ? { ...t, content, isDirty: true } : t),
    }));
  },

  setTabConnection: (id, connectionId, database, profileId) => {
    set((state) => ({
      tabs: state.tabs.map((t) => {
        if (t.id !== id) return t;
        const profile = profileId !== undefined ? { profileId } : {};
        // A structure, designer or routine tab is *about* a database, so an
        // undefined one would leave it pointing at nothing. The flat interface
        // let that through; keep what the tab already has instead. Only a
        // query tab can legitimately have no database.
        if (t.type !== "query" && t.type !== "admin") {
          return { ...t, connectionId, database: database ?? t.database, ...profile };
        }
        return { ...t, connectionId, database, ...profile };
      }),
    }));
  },

  setEditorInstance: (instance) => set({ editorInstance: instance }),

  setTabDirty: (tabId, dirty) =>
    set((state) => ({
      tabs: state.tabs.map((t) => t.id === tabId ? { ...t, isDirty: dirty } : t),
    })),

  renameTab: (tabId, newTitle) =>
    set((state) => ({
      tabs: state.tabs.map((t) => t.id === tabId ? { ...t, title: newTitle } : t),
    })),

  reorderTabs: (fromIndex, toIndex) =>
    set((state) => {
      const newTabs = [...state.tabs];
      const [moved] = newTabs.splice(fromIndex, 1);
      newTabs.splice(toIndex, 0, moved);
      return { tabs: newTabs };
    }),
}));

// Auto-save tabs and activeTabId to localStorage on change, debounced to avoid
// writing on every keystroke. editorInstance is intentionally excluded.
let _savedTabs: EditorTab[] = useEditorStore.getState().tabs;
let _savedActiveTabId: string | null = useEditorStore.getState().activeTabId;
let _saveTimeout: ReturnType<typeof setTimeout> | null = null;

useEditorStore.subscribe((state) => {
  if (state.tabs !== _savedTabs || state.activeTabId !== _savedActiveTabId) {
    _savedTabs = state.tabs;
    _savedActiveTabId = state.activeTabId;
    if (_saveTimeout) clearTimeout(_saveTimeout);
    _saveTimeout = setTimeout(() => {
      const { tabs, activeTabId } = useEditorStore.getState();
      saveSession(tabs, activeTabId);
    }, 500);
  }
});
