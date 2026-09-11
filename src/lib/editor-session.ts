import type { EditorTab } from "../types";

/**
 * The editor session on disk: which tabs were open, and which was in front.
 *
 * Lifted out of `editorStore`, which was carrying the parser, the reader, the
 * writer and the tab-counter recovery alongside the store itself (#286). None
 * of it is state; all of it is about turning a file into tabs and back.
 */

const SESSION_STORAGE_KEY = "sqlpilot-editor-session";

export interface PersistedSession {
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

export function loadSession(): PersistedSession | null {
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

export function saveSession(tabs: EditorTab[], activeTabId: string | null) {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ tabs, activeTabId }));
  } catch {
    // localStorage unavailable
  }
}

export function maxTabCounter(tabs: EditorTab[]): number {
  return tabs.reduce((max, t) => {
    const m = t.id.match(/^tab-(\d+)$/);
    return m ? Math.max(max, parseInt(m[1], 10)) : max;
  }, 0);
}
