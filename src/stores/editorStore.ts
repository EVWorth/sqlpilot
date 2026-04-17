import { create } from "zustand";
import type { editor } from "monaco-editor";
import type { EditorTab } from "../types";

interface EditorState {
  tabs: EditorTab[];
  activeTabId: string | null;
  editorInstance: editor.IStandaloneCodeEditor | null;

  addTab: (connectionId?: string, database?: string) => string;
  addStructureTab: (connectionId: string, database: string, tableName: string) => string;
  addAdminTab: (connectionId: string) => string;
  addQueryBuilderTab: (connectionId: string, database: string) => string;
  addRoutineTab: (connectionId: string, database: string, routineName: string, routineType: string) => string;
  addCompareTab: () => string;
  addDesignerTab: (connectionId: string, database: string, tableName?: string) => string;
  closeTab: (id: string) => void;
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

const SESSION_STORAGE_KEY = "sqlpilot-editor-session";

interface PersistedSession {
  tabs: EditorTab[];
  activeTabId: string | null;
}

function loadSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSession;
    if (!Array.isArray(parsed.tabs) || parsed.tabs.length === 0) return null;
    // Clear isDirty — the persisted content is now the baseline
    return {
      tabs: parsed.tabs.map((t) => ({ ...t, isDirty: false })),
      activeTabId: parsed.activeTabId,
    };
  } catch {
    return null;
  }
}

function saveSession(tabs: EditorTab[], activeTabId: string | null) {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ tabs, activeTabId }));
  } catch {
    // localStorage unavailable
  }
}

function maxTabCounter(tabs: EditorTab[]): number {
  return tabs.reduce((max, t) => {
    const m = t.id.match(/^tab-(\d+)$/);
    return m ? Math.max(max, parseInt(m[1], 10)) : max;
  }, 0);
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

  addTab: (connectionId, database) => {
    tabCounter++;
    const id = `tab-${tabCounter}`;
    const tab: EditorTab = {
      id,
      title: "Untitled Query",
      content: "",
      connectionId,
      database,
      type: 'query',
      isDirty: false,
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: id,
    }));
    return id;
  },

  addStructureTab: (connectionId, database, tableName) => {
    const existing = get().tabs.find(
      (t) =>
        t.type === 'structure' &&
        t.connectionId === connectionId &&
        t.database === database &&
        t.tableName === tableName,
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    tabCounter++;
    const id = `tab-${tabCounter}`;
    const tab: EditorTab = {
      id,
      title: `⊞ ${tableName}`,
      content: "",
      connectionId,
      database,
      tableName,
      type: 'structure',
      isDirty: false,
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: id,
    }));
    return id;
  },

  addRoutineTab: (connectionId, database, routineName, routineType) => {
    const existing = get().tabs.find(
      (t) =>
        t.type === 'routine' &&
        t.connectionId === connectionId &&
        t.database === database &&
        t.routineName === routineName &&
        t.routineType === routineType,
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    tabCounter++;
    const id = `tab-${tabCounter}`;
    const icon = routineType === 'PROCEDURE' ? '⚙' : 'ƒ';
    const tab: EditorTab = {
      id,
      title: `${icon} ${routineName}`,
      content: "",
      connectionId,
      database,
      routineName,
      routineType,
      type: 'routine',
      isDirty: false,
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: id,
    }));
    return id;
  },

  addAdminTab: (connectionId) => {
    const existing = get().tabs.find(
      (t) => t.type === 'admin' && t.connectionId === connectionId,
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    tabCounter++;
    const id = `tab-${tabCounter}`;
    const tab: EditorTab = {
      id,
      title: "🔧 Admin",
      content: "",
      connectionId,
      type: 'admin',
      isDirty: false,
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: id,
    }));
    return id;
  },

  addCompareTab: () => {
    const existing = get().tabs.find((t) => t.type === 'compare');
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    tabCounter++;
    const id = `tab-${tabCounter}`;
    const tab: EditorTab = {
      id,
      title: "⇄ Compare",
      content: "",
      type: 'compare',
      isDirty: false,
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: id,
    }));
    return id;
  },

  addDesignerTab: (connectionId, database, tableName?) => {
    const existing = get().tabs.find(
      (t) =>
        t.type === 'designer' &&
        t.connectionId === connectionId &&
        t.database === database &&
        t.tableName === (tableName || undefined),
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    tabCounter++;
    const id = `tab-${tabCounter}`;
    const title = tableName ? `🔧 ${tableName}` : `🔧 New Table`;
    const tab: EditorTab = {
      id,
      title,
      content: "",
      connectionId,
      database,
      tableName: tableName || undefined,
      type: 'designer',
      isDirty: false,
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: id,
    }));
    return id;
  },

  addQueryBuilderTab: (connectionId, database) => {
    tabCounter++;
    const id = `tab-${tabCounter}`;
    const tab: EditorTab = {
      id,
      title: "🔧 Query Builder",
      content: "",
      connectionId,
      database,
      type: "querybuilder",
      isDirty: false,
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: id,
    }));
    return id;
  },

  closeTab: (id) => {
    set((state) => {
      const tabToClose = state.tabs.find((t) => t.id === id);
      // Don't close the last query tab
      if (tabToClose?.type === 'query') {
        const queryTabs = state.tabs.filter((t) => t.type === 'query');
        if (queryTabs.length <= 1) return state;
      }
      const newTabs = state.tabs.filter((t) => t.id !== id);
      const newActiveId =
        state.activeTabId === id
          ? newTabs.length > 0
            ? newTabs[newTabs.length - 1].id
            : null
          : state.activeTabId;
      return { tabs: newTabs, activeTabId: newActiveId };
    });
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  updateTabContent: (id, content) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, content, isDirty: true } : t,
      ),
    }));
  },

  setTabConnection: (id, connectionId, database, profileId) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id
          ? { ...t, connectionId, database, ...(profileId !== undefined ? { profileId } : {}) }
          : t,
      ),
    }));
  },

  setEditorInstance: (instance) => set({ editorInstance: instance }),

  setTabDirty: (tabId, dirty) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, isDirty: dirty } : t,
      ),
    })),

  renameTab: (tabId, newTitle) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, title: newTitle } : t,
      ),
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
