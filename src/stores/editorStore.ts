import type { editor } from "monaco-editor";
import { create } from "zustand";
import type { EditorTab, RoutineKind } from "../types";

interface EditorState {
  tabs: EditorTab[];
  activeTabId: string | null;
  editorInstance: editor.IStandaloneCodeEditor | null;

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

const SESSION_STORAGE_KEY = "sqlpilot-editor-session";

interface PersistedSession {
  tabs: EditorTab[];
  activeTabId: string | null;
}

/**
 * Turn one persisted tab into a valid `EditorTab`, or drop it.
 *
 * The union only holds if what comes back from storage actually satisfies it.
 * A session written by an older build has no `type` at all — that field used
 * to be optional and meant "query" — and a tab whose kind requires a database
 * or a routine name may not have one, in which case rendering it would hand a
 * panel undefined props. Dropping the tab loses a tab; keeping it loses the
 * guarantee the rest of the code now relies on (#449).
 */
export function parsePersistedTab(raw: unknown): EditorTab | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Record<string, unknown>;

  const str = (k: string) => typeof t[k] === "string" ? t[k] as string : undefined;
  const id = str("id");
  const title = str("title");
  if (!id || !title) return null;

  const base = {
    id,
    title,
    content: str("content") ?? "",
    // The persisted content is the new baseline, so nothing is dirty on load.
    isDirty: false,
    connectionId: str("connectionId"),
    profileId: str("profileId"),
    database: str("database"),
  };

  // Absent means query: that is what the old optional field meant.
  switch (str("type") ?? "query") {
    case "query":
      return { ...base, type: "query" };
    case "admin":
      return base.connectionId ? { ...base, type: "admin", connectionId: base.connectionId } : null;
    case "structure": {
      const tableName = str("tableName");
      if (!base.connectionId || !base.database || !tableName) return null;
      return {
        ...base,
        type: "structure",
        connectionId: base.connectionId,
        database: base.database,
        tableName,
      };
    }
    case "designer":
      if (!base.connectionId || !base.database) return null;
      return {
        ...base,
        type: "designer",
        connectionId: base.connectionId,
        database: base.database,
        tableName: str("tableName"),
      };
    case "routine": {
      const routineName = str("routineName");
      const routineType = str("routineType");
      if (!base.connectionId || !base.database || !routineName) return null;
      if (routineType !== "PROCEDURE" && routineType !== "FUNCTION") return null;
      return {
        ...base,
        type: "routine",
        connectionId: base.connectionId,
        database: base.database,
        routineName,
        routineType,
      };
    }
    default:
      // A kind this build does not know — `compare` was one, before it was
      // cut. Dropping it beats rendering a tab nothing can display.
      return null;
  }
}

function loadSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { tabs?: unknown; activeTabId?: unknown };
    if (!Array.isArray(parsed.tabs) || parsed.tabs.length === 0) return null;

    const tabs = parsed.tabs.map(parsePersistedTab).filter((t): t is EditorTab => t !== null);
    if (tabs.length === 0) return null;

    // An active id pointing at a dropped tab would leave nothing selected.
    const activeTabId = typeof parsed.activeTabId === "string" ? parsed.activeTabId : null;
    return {
      tabs,
      activeTabId: tabs.some((t) => t.id === activeTabId) ? activeTabId : tabs[0].id,
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
      type: "query",
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
        t.type === "structure"
        && t.connectionId === connectionId
        && t.database === database
        && t.tableName === tableName,
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
      type: "structure",
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
        t.type === "routine"
        && t.connectionId === connectionId
        && t.database === database
        && t.routineName === routineName
        && t.routineType === routineType,
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    tabCounter++;
    const id = `tab-${tabCounter}`;
    const icon = routineType === "PROCEDURE" ? "⚙" : "ƒ";
    const tab: EditorTab = {
      id,
      title: `${icon} ${routineName}`,
      content: "",
      connectionId,
      database,
      routineName,
      routineType,
      type: "routine",
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
      (t) => t.type === "admin" && t.connectionId === connectionId,
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
      type: "admin",
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
        t.type === "designer"
        && t.connectionId === connectionId
        && t.database === database
        && t.tableName === (tableName || undefined),
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
      type: "designer",
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
