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

  /**
   * Close one tab.
   *
   * Closing the last query tab leaves a fresh empty one rather than an editor
   * with nothing in it. The replacement keeps the connection and database the
   * closed tab was pointing at: someone who has picked a server and a database
   * and then clears their scratch query has not asked to be disconnected.
   */
  closeTab: (id) => {
    set((state) => {
      const closing = state.tabs.find((t) => t.id === id);
      if (!closing) return state;

      if (closing.type === "query" && state.tabs.filter((t) => t.type === "query").length <= 1) {
        tabCounter++;
        const replacement = buildTab(`tab-${tabCounter}`, "query", {
          connectionId: closing.connectionId,
          database: closing.database,
        });
        return {
          tabs: state.tabs.map((t) => (t.id === id ? replacement : t)),
          activeTabId: replacement.id,
        };
      }

      const remaining = state.tabs.filter((t) => t.id !== id);
      return {
        tabs: remaining,
        activeTabId: state.activeTabId === id
          ? remaining.length > 0 ? remaining[remaining.length - 1].id : null
          : state.activeTabId,
      };
    });
  },

  /**
   * Close every tab but this one.
   *
   * It used to keep every tab of a different type, so "Close Others" on a
   * query tab left all the structure and admin tabs open (#298 F-backlog).
   * The menu item says others, and every other client means all of them.
   */
  closeOtherTabs: (id) => {
    set((state) => {
      const keep = state.tabs.find((t) => t.id === id);
      if (!keep) return state;
      return { tabs: [keep], activeTabId: id };
    });
  },

  /**
   * Close the tabs after this one in the strip.
   *
   * Positional, like the menu item reads. The previous version filtered by
   * type as well, which left tabs visibly to the right still open.
   */
  closeTabsToRight: (id) => {
    set((state) => {
      const idx = state.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return state;
      const remaining = state.tabs.slice(0, idx + 1);
      // Only move if the active tab is one of the ones that just went.
      const activeSurvives = remaining.some((t) => t.id === state.activeTabId);
      return { tabs: remaining, activeTabId: activeSurvives ? state.activeTabId : id };
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
