import type { editor } from "monaco-editor";
import { create } from "zustand";
import { loadSession, maxTabCounter, saveSession } from "../lib/editor-session";
import { buildTab, findOpenTab, type TabKind, type TabParams } from "../lib/tab-kinds";
import type { EditorTab, RoutineKind } from "../types";
import { useTransactionStore } from "./transactionStore";

/** Which close command is waiting on the user (#843). */
export type CloseKind = "close" | "others" | "right";

export interface PendingClose {
  kind: CloseKind;
  /** The tab the command was given on. */
  targetId: string;
  /** The tabs it would close that hold work, for the prompt to name. */
  atRisk: EditorTab[];
  /**
   * Those of them whose closing rolls back an open transaction (#843): their
   * own session's, or that of the shared SQLite connection they are the last
   * tabs on (#935). Also listed in `atRisk`.
   */
  inTransaction: EditorTab[];
}

/**
 * Something the user asked for that would end the server session of a tab
 * with an open transaction, and so roll it back: pointing the tab at another
 * connection, or reconnecting its server (#843).
 */
export interface PendingSwitch {
  /** The tabs whose transaction it would roll back. */
  inTransaction: EditorTab[];
  /** What the user asked for, run once they agree. */
  proceed: () => void;
}

/** The tabs a close command would remove. */
export function tabsClosedBy(tabs: readonly EditorTab[], kind: CloseKind, id: string): EditorTab[] {
  if (kind === "close") return tabs.filter((t) => t.id === id);
  if (kind === "others") return tabs.some((t) => t.id === id) ? tabs.filter((t) => t.id !== id) : [];
  const idx = tabs.findIndex((t) => t.id === id);
  return idx === -1 ? [] : tabs.slice(idx + 1);
}

/**
 * What a close command leaves bound to a connection: the tabs it keeps, and
 * the fresh query tab that replaces the last query tab closed, which keeps
 * that tab's connection (see `closeTab`).
 */
function tabsLeftBy(tabs: readonly EditorTab[], kind: CloseKind, id: string): Pick<EditorTab, "connectionId">[] {
  const closing = tabsClosedBy(tabs, kind, id);
  const left: Pick<EditorTab, "connectionId">[] = tabs.filter((t) => !closing.includes(t));
  const only = closing[0];
  if (kind === "close" && only?.type === "query" && tabs.filter((t) => t.type === "query").length <= 1) {
    left.push({ connectionId: only.connectionId });
  }
  return left;
}

/**
 * Which of the tabs `leaving` would roll back an open transaction by going
 * (#843, #935).
 *
 * A MySQL tab's transaction is on its own session, which goes with it. A
 * SQLite tab's is on the file's one connection, shared with every other tab
 * bound to it, so it ends only when the last of them goes: `staying` is what
 * remains bound afterwards. `lib/sqlite-transactions` rolls it back then.
 */
export function transactionsEndedBy(
  leaving: readonly EditorTab[],
  staying: readonly Pick<EditorTab, "connectionId">[],
): EditorTab[] {
  const { open, openConnections } = useTransactionStore.getState();
  return leaving.filter((t) =>
    open[t.id]
    || (t.connectionId !== undefined && openConnections[t.connectionId]
      && !staying.some((s) => s.connectionId === t.connectionId))
  );
}

/**
 * Whether closing this tab would throw work away: a query tab whose SQL was
 * typed or edited. Its text exists nowhere else once the tab goes.
 */
export function holdsUnsavedWork(tab: EditorTab): boolean {
  return tab.type === "query" && tab.isDirty && tab.content.trim().length > 0;
}

/**
 * Writes the editor's typing that is still waiting on its debounce into the
 * store. Registered by the editor; a close asks it first, so SQL typed in the
 * last 150 ms counts as the tab's content (#861).
 */
let pendingContentFlush: (() => void) | null = null;

/** Register (or, with null, drop) the editor's pending-content flush. */
export function setPendingContentFlush(flush: (() => void) | null) {
  pendingContentFlush = flush;
}

/**
 * "Untitled-N" for a new query tab, N the lowest number no open tab uses.
 *
 * Every new tab was "Untitled Query", so two could not be told apart
 * (FR-2.1.3, #853).
 */
export function nextUntitledTitle(tabs: readonly EditorTab[]): string {
  const used = new Set(tabs.map((t) => /^Untitled-(\d+)$/.exec(t.title)?.[1]).filter(Boolean).map(Number));
  let n = 1;
  while (used.has(n)) n++;
  return `Untitled-${n}`;
}

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
  /**
   * Close as the user asked, but ask first when a tab that would go holds
   * unsaved SQL (#843). The plain `close*` actions above close unconditionally.
   */
  requestClose: (kind: CloseKind, id: string) => void;
  /** The close waiting on the user's answer, if any. */
  pendingClose: PendingClose | null;
  confirmPendingClose: () => void;
  cancelPendingClose: () => void;
  /**
   * Run `proceed`, which ends the sessions of `tabIds`: now when none of them
   * has a transaction open, otherwise once the user agrees to roll it back
   * (#843).
   */
  confirmRollback: (tabIds: readonly string[], proceed: () => void) => void;
  /** The switch waiting on the user's answer, if any. */
  pendingSwitch: PendingSwitch | null;
  confirmPendingSwitch: () => void;
  cancelPendingSwitch: () => void;
  /**
   * Point a tab at a connection, asking first when that moves it off a
   * server where its transaction is open (#843). `setTabConnection` sets it
   * unconditionally.
   */
  requestTabConnection: (id: string, connectionId: string, database?: string, profileId?: string) => void;
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
  /**
   * Record that `content` has been saved from this tab — to a favorite, say —
   * so the tab is clean until its text differs from that again (#855).
   */
  markTabSaved: (tabId: string, content: string) => void;
  renameTab: (tabId: string, newTitle: string) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
}

const restoredSession = loadSession();

let tabCounter = restoredSession ? maxTabCounter(restoredSession.tabs) : 0;

const initialTab: EditorTab = {
  id: "tab-0",
  title: "Untitled-1",
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
  pendingClose: null,
  pendingSwitch: null,

  requestClose: (kind, id) => {
    pendingContentFlush?.();
    const closing = tabsClosedBy(get().tabs, kind, id);
    // An open transaction is work too: closing the tab ends its session,
    // which rolls the transaction back (#843). On a SQLite file only closing
    // the last tab on it does (#935).
    const inTransaction = transactionsEndedBy(closing, tabsLeftBy(get().tabs, kind, id));
    const atRisk = closing.filter((t) => holdsUnsavedWork(t) || inTransaction.includes(t));
    if (atRisk.length > 0) {
      set({ pendingClose: { kind, targetId: id, atRisk, inTransaction } });
      return;
    }
    runClose(get(), kind, id);
  },

  confirmPendingClose: () => {
    const pending = get().pendingClose;
    if (!pending) return;
    set({ pendingClose: null });
    runClose(get(), pending.kind, pending.targetId);
  },

  cancelPendingClose: () => set({ pendingClose: null }),

  confirmRollback: (tabIds, proceed) => {
    const tabs = get().tabs;
    const inTransaction = transactionsEndedBy(
      tabs.filter((t) => tabIds.includes(t.id)),
      tabs.filter((t) => !tabIds.includes(t.id)),
    );
    if (inTransaction.length === 0) {
      proceed();
      return;
    }
    set({ pendingSwitch: { inTransaction, proceed } });
  },

  confirmPendingSwitch: () => {
    const pending = get().pendingSwitch;
    if (!pending) return;
    set({ pendingSwitch: null });
    pending.proceed();
  },

  cancelPendingSwitch: () => set({ pendingSwitch: null }),

  requestTabConnection: (id, connectionId, database, profileId) => {
    const tab = get().tabs.find((t) => t.id === id);
    const apply = () => get().setTabConnection(id, connectionId, database, profileId);
    // Another database on the same server keeps the session, and with it the
    // transaction; only another connection ends it. On a SQLite file, only
    // when no other tab stays on the file (#935).
    const moving = tab?.connectionId !== undefined && tab.connectionId !== connectionId;
    if (!moving) {
      apply();
      return;
    }
    get().confirmRollback([id], apply);
  },

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
    const built = buildTab(`tab-${tabCounter}`, kind, params);
    const tab = kind === "query" ? { ...built, title: nextUntitledTitle(get().tabs) } : built;
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
        const replacement = {
          ...buildTab(`tab-${tabCounter}`, "query", {
            connectionId: closing.connectionId,
            database: closing.database,
          }),
          title: nextUntitledTitle(state.tabs.filter((t) => t.id !== id)),
        };
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
      // Dirty means "differs from what was last saved", so typing back to
      // the saved text, or undoing to it, counts as clean again (#855).
      tabs: state.tabs.map((t) => t.id === id ? { ...t, content, isDirty: content !== (t.savedContent ?? "") } : t),
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
      // Clean means the current text is the saved one.
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, isDirty: dirty, ...(dirty ? {} : { savedContent: t.content }) } : t
      ),
    })),

  markTabSaved: (tabId, content) =>
    set((state) => ({
      tabs: state.tabs.map((t) => t.id === tabId ? { ...t, savedContent: content, isDirty: t.content !== content } : t),
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

function runClose(state: EditorState, kind: CloseKind, id: string) {
  if (kind === "close") state.closeTab(id);
  else if (kind === "others") state.closeOtherTabs(id);
  else state.closeTabsToRight(id);
}

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
