import { create } from "zustand";
import { attachProgress } from "../lib/backup-progress";
import {
  type BackupOptions,
  type BackupProgress,
  type BackupSummary,
  events,
  type FileHead,
  type RestoreOptions,
  type RestoreProgress,
  type RestoreSummary,
} from "../lib/bindings";
import { api } from "../lib/tauri-api";
import type { ColumnInfo, DatabaseInfo, TableInfo } from "../types";

/**
 * Backups, restores and SQL imports, and the reads their dialogs make (#862).
 *
 * The dialogs called the API themselves and each kept its own copy of the
 * run's state. The run lives here now: the job id that progress events and
 * Cancel are matched on, whether it is running, its progress, and how it
 * ended. An SQL import is a restore of the chosen file (#359), so it has a
 * restore run of its own.
 */

export interface BackupRun {
  /** The id the progress events carry, so two runs do not draw each other's rows. */
  id: string | null;
  running: boolean;
  progress: BackupProgress | null;
  /**
   * Where the current table's rows began. `rowsExported` counts every table
   * so far, so the bar and the estimate need this to use the table's own.
   */
  tableStartRows: number;
  /** Set when a run completed. A cancelled backup leaves no file, so it has none. */
  summary: BackupSummary | null;
  /** What the run left out, cancelled or not. */
  warnings: string[];
  /** A cancelled run used to drop back to the plain form, saying nothing (#811). */
  cancelled: boolean;
  error: string | null;
}

export interface RestoreRun {
  id: string | null;
  running: boolean;
  /** Set once Cancel was pressed, until the run stops at a statement. */
  cancelling: boolean;
  progress: RestoreProgress | null;
  summary: RestoreSummary | null;
  error: string | null;
}

/** Which dialog a restore run belongs to. */
export type RestoreSlot = "restore" | "import";

export interface BackupRequest {
  connectionId: string;
  database: string;
  tables: string[];
  options: BackupOptions;
  filePath: string;
}

export interface RestoreRequest {
  connectionId: string;
  database: string;
  filePath: string;
  options: RestoreOptions;
}

interface BackupState {
  backup: BackupRun;
  restore: RestoreRun;
  import: RestoreRun;

  /** The databases a dialog offers. Rejects as the API does. */
  listDatabases: (connectionId: string) => Promise<DatabaseInfo[]>;
  /** The tables a dialog offers. Rejects as the API does. */
  listTables: (connectionId: string, database: string) => Promise<TableInfo[]>;
  /** A target table's columns, for mapping an import. Rejects as the API does. */
  listColumns: (connectionId: string, database: string, table: string) => Promise<ColumnInfo[]>;

  /** Run a backup to `filePath`. How it ended is in `backup`. */
  runBackup: (request: BackupRequest) => Promise<void>;
  /** Ask the running backup to stop; it removes the partial file. */
  cancelBackup: () => void;
  /** Clear how the last backup ended, for a freshly opened dialog. */
  resetBackup: () => void;

  /**
   * Read the head of a dump to preview it, clearing the slot's last outcome.
   * Null when it could not be read; the slot's `error` says why.
   */
  previewDump: (slot: RestoreSlot, path: string, maxBytes: number) => Promise<FileHead | null>;
  /**
   * Run a restore of `filePath`. Resolves to its summary, or null when it
   * failed, with the reason in the slot's `error`.
   */
  runRestore: (slot: RestoreSlot, request: RestoreRequest) => Promise<RestoreSummary | null>;
  /**
   * Ask the slot's running restore to stop at the next statement and roll
   * back what has not been committed.
   */
  cancelRestore: (slot: RestoreSlot) => void;
  /** Clear how the slot's last restore ended, for a freshly opened dialog. */
  resetRestore: (slot: RestoreSlot) => void;
}

const IDLE_BACKUP: BackupRun = {
  id: null,
  running: false,
  progress: null,
  tableStartRows: 0,
  summary: null,
  warnings: [],
  cancelled: false,
  error: null,
};

const IDLE_RESTORE: RestoreRun = {
  id: null,
  running: false,
  cancelling: false,
  progress: null,
  summary: null,
  error: null,
};

export const useBackupStore = create<BackupState>((set, get) => {
  function patchBackup(patch: Partial<BackupRun>) {
    set((s) => ({ backup: { ...s.backup, ...patch } }));
  }

  function patchRestore(slot: RestoreSlot, patch: Partial<RestoreRun>) {
    set((s) => ({ [slot]: { ...s[slot], ...patch } }) as Partial<BackupState>);
  }

  return {
    backup: IDLE_BACKUP,
    restore: IDLE_RESTORE,
    import: IDLE_RESTORE,

    listDatabases: (connectionId) => api.getDatabases(connectionId),
    listTables: (connectionId, database) => api.getTables(connectionId, database),
    listColumns: (connectionId, database, table) => api.getColumns(connectionId, database, table),

    runBackup: async ({ connectionId, database, tables, options, filePath }) => {
      if (tables.length === 0) {
        patchBackup({ error: "No tables selected" });
        return;
      }

      const id = crypto.randomUUID();
      patchBackup({
        id,
        running: true,
        error: null,
        summary: null,
        cancelled: false,
        progress: null,
        warnings: [],
        tableStartRows: 0,
      });

      // A progress listener that cannot attach is not a reason to refuse to
      // run: the work still happens, the bar just does not move.
      let table = 0;
      let startRows = 0;
      let lastRows = 0;
      const unlisten = await attachProgress(() =>
        events.backupProgressEvent.listen((e) => {
          if (e.payload.backupId !== id) return;
          const next = e.payload.progress;
          if (next.currentTable !== table) {
            table = next.currentTable;
            startRows = lastRows;
          }
          lastRows = next.rowsExported;
          patchBackup({ progress: next, tableStartRows: startRows });
        })
      );

      try {
        const summary = await api.backupDatabase(id, connectionId, database, tables, options, filePath);
        patchBackup(
          summary.cancelled
            ? { warnings: summary.warnings, cancelled: true }
            : { warnings: summary.warnings, summary },
        );
      } catch (e) {
        patchBackup({ error: String(e) });
      } finally {
        unlisten();
        patchBackup({ id: null, running: false });
      }
    },

    cancelBackup: () => {
      const { id } = get().backup;
      // The dump stops at the next row and removes the partial file, so there
      // is nothing left that could be mistaken for a backup.
      if (id) void api.cancelBackup(id).catch(() => {});
    },

    resetBackup: () =>
      // Not the id: a run still going must stay cancellable.
      patchBackup({
        running: false,
        progress: null,
        summary: null,
        warnings: [],
        cancelled: false,
        error: null,
      }),

    previewDump: async (slot, path, maxBytes) => {
      patchRestore(slot, { summary: null, error: null });
      try {
        return await api.readFileHead(path, maxBytes);
      } catch (e) {
        patchRestore(slot, { error: String(e) });
        return null;
      }
    },

    runRestore: async (slot, { connectionId, database, filePath, options }) => {
      const id = crypto.randomUUID();
      patchRestore(slot, { id, running: true, cancelling: false, progress: null, summary: null, error: null });

      // A progress listener that cannot attach is not a reason to refuse to
      // run: the work still happens, the bar just does not move.
      const unlisten = await attachProgress(() =>
        events.restoreProgressEvent.listen((e) => {
          if (e.payload.restoreId === id) patchRestore(slot, { progress: e.payload.progress });
        })
      );

      try {
        const summary = await api.restoreDatabase(id, connectionId, database, filePath, options);
        patchRestore(slot, { summary });
        return summary;
      } catch (e) {
        patchRestore(slot, { error: String(e) });
        return null;
      } finally {
        unlisten();
        patchRestore(slot, { id: null, running: false, cancelling: false });
      }
    },

    cancelRestore: (slot) => {
      const { id } = get()[slot];
      if (!id) return;
      patchRestore(slot, { cancelling: true });
      void api.cancelBackup(id).catch(() => {});
    },

    resetRestore: (slot) =>
      patchRestore(slot, { running: false, cancelling: false, progress: null, summary: null, error: null }),
  };
});
