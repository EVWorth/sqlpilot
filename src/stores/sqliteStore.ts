import { create } from "zustand";
import { forgetConnectionKind, registerConnectionKind } from "../lib/datasource";
import { api } from "../lib/tauri-api";

/**
 * SQLite databases the user has opened.
 *
 * Kept apart from `connectionStore`, which holds MySQL sessions with hosts,
 * ports, server versions and profiles — none of which a file has. Both are
 * rendered by the same pane through the data-source layer, so the separation
 * costs nothing at the point of use and keeps either backend from having to
 * pretend to be the other.
 */

export interface SqliteSession {
  /** Connection id from the backend, the same currency as a MySQL one. */
  id: string;
  /** Absolute path of the file. */
  path: string;
  /** Basename, which is what the UI shows. */
  name: string;
  openedAt: string;
}

interface SqliteState {
  sessions: SqliteSession[];
  opening: boolean;
  error: string | null;

  /** Ask for a file and open it. Returns the new session, or null. */
  openFile: () => Promise<SqliteSession | null>;
  /** Open a known path, for reopening a recent file. */
  openPath: (path: string) => Promise<SqliteSession | null>;
  close: (connectionId: string) => Promise<void>;
  clearError: () => void;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export const useSqliteStore = create<SqliteState>((set, get) => ({
  sessions: [],
  opening: false,
  error: null,

  openFile: async () => {
    let path: string | null;
    try {
      path = await api.pickFile("Open SQLite database", [
        ["SQLite database", ["db", "sqlite", "sqlite3", "db3"]],
        ["All files", ["*"]],
      ]);
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
    // The picker was dismissed. Not an error, and nothing to report.
    if (!path) return null;
    return get().openPath(path);
  },

  openPath: async (path) => {
    // Already open: select it rather than opening a second handle on the
    // same file, which SQLite allows and which would confuse the tab list.
    const existing = get().sessions.find((s) => s.path === path);
    if (existing) return existing;

    set({ opening: true, error: null });
    try {
      const id = await api.sqliteOpen(path);
      const session: SqliteSession = {
        id,
        path,
        name: basename(path),
        openedAt: new Date().toISOString(),
      };
      registerConnectionKind(id, "sqlite");
      set((state) => ({ sessions: [...state.sessions, session], opening: false }));
      return session;
    } catch (e) {
      set({ error: String(e), opening: false });
      return null;
    }
  },

  close: async (connectionId) => {
    // Dropped from the list whatever the backend says: leaving a session the
    // user asked to close on screen is worse than an orphaned handle, and the
    // handle goes when the app does.
    set((state) => ({ sessions: state.sessions.filter((s) => s.id !== connectionId) }));
    forgetConnectionKind(connectionId);
    try {
      await api.sqliteClose(connectionId);
    } catch (e) {
      set({ error: `Closed, but the backend reported: ${String(e)}` });
    }
  },

  clearError: () => set({ error: null }),
}));
