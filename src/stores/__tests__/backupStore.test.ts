import { beforeEach, describe, expect, it, vi } from "vitest";

const { api, listeners } = vi.hoisted(() => ({
  api: {
    getDatabases: vi.fn(),
    getTables: vi.fn(),
    getColumns: vi.fn(),
    backupDatabase: vi.fn(),
    restoreDatabase: vi.fn(),
    cancelBackup: vi.fn(),
    readFileHead: vi.fn(),
  },
  listeners: {
    backup: [] as ((e: { payload: unknown }) => void)[],
    restore: [] as ((e: { payload: unknown }) => void)[],
  },
}));

vi.mock("../../lib/tauri-api", () => ({ api }));
vi.mock("../../lib/bindings", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  events: {
    backupProgressEvent: {
      listen: vi.fn(async (cb: (e: { payload: unknown }) => void) => {
        listeners.backup.push(cb);
        return () => {
          listeners.backup = listeners.backup.filter((l) => l !== cb);
        };
      }),
    },
    restoreProgressEvent: {
      listen: vi.fn(async (cb: (e: { payload: unknown }) => void) => {
        listeners.restore.push(cb);
        return () => {
          listeners.restore = listeners.restore.filter((l) => l !== cb);
        };
      }),
    },
  },
}));

import { useBackupStore } from "../backupStore";

const backupRequest = {
  connectionId: "conn-1",
  database: "shop",
  tables: ["orders"],
  options: {} as never,
  filePath: "/backups/shop.sql",
};

const restoreRequest = {
  connectionId: "conn-1",
  database: "shop",
  filePath: "/backups/shop.sql",
  options: { stopOnError: true, disableForeignKeyChecks: true, wrapInTransaction: true },
};

const backupSummary = { cancelled: false, warnings: ["skipped a view"], rowsExported: 3 };
const restoreSummary = { cancelled: false, statementsRun: 4, statementsFailed: 0, errors: [] };

function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let the store attach its progress listener. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("backupStore", () => {
  beforeEach(() => {
    const idle = useBackupStore.getInitialState();
    useBackupStore.setState({ backup: idle.backup, restore: idle.restore, import: idle.import });
    for (const fn of Object.values(api)) fn.mockReset();
    api.cancelBackup.mockResolvedValue(undefined);
    listeners.backup = [];
    listeners.restore = [];
  });

  describe("runBackup", () => {
    it("refuses to run with no tables", async () => {
      await useBackupStore.getState().runBackup({ ...backupRequest, tables: [] });

      expect(api.backupDatabase).not.toHaveBeenCalled();
      expect(useBackupStore.getState().backup.error).toBe("No tables selected");
    });

    it("is running until the backend answers, then keeps the summary", async () => {
      const run = deferred<unknown>();
      api.backupDatabase.mockReturnValue(run.promise);

      const pending = useBackupStore.getState().runBackup(backupRequest);
      expect(useBackupStore.getState().backup.running).toBe(true);
      await flush();
      const id = useBackupStore.getState().backup.id;
      expect(api.backupDatabase).toHaveBeenCalledWith(
        id,
        "conn-1",
        "shop",
        ["orders"],
        {},
        "/backups/shop.sql",
      );

      run.resolve(backupSummary);
      await pending;
      const { backup } = useBackupStore.getState();
      expect(backup).toMatchObject({
        id: null,
        running: false,
        summary: backupSummary,
        warnings: ["skipped a view"],
        cancelled: false,
        error: null,
      });
    });

    it("says a cancelled backup was cancelled and keeps no summary", async () => {
      api.backupDatabase.mockResolvedValue({ ...backupSummary, cancelled: true });

      await useBackupStore.getState().runBackup(backupRequest);

      expect(useBackupStore.getState().backup).toMatchObject({
        summary: null,
        cancelled: true,
        warnings: ["skipped a view"],
      });
    });

    it("keeps the failure", async () => {
      api.backupDatabase.mockRejectedValue("disk full");

      await useBackupStore.getState().runBackup(backupRequest);

      expect(useBackupStore.getState().backup).toMatchObject({ error: "disk full", running: false });
    });

    it("follows its own progress events and where each table's rows began", async () => {
      const run = deferred<unknown>();
      api.backupDatabase.mockReturnValue(run.promise);
      const pending = useBackupStore.getState().runBackup(backupRequest);
      await flush();
      const id = useBackupStore.getState().backup.id;
      const emit = (backupId: string | null, progress: object) =>
        listeners.backup.forEach((l) => l({ payload: { backupId, progress } }));

      emit(id, { currentTable: 1, rowsExported: 40 });
      emit("someone-else", { currentTable: 9, rowsExported: 999 });
      emit(id, { currentTable: 2, rowsExported: 50 });

      expect(useBackupStore.getState().backup.progress).toEqual({ currentTable: 2, rowsExported: 50 });
      expect(useBackupStore.getState().backup.tableStartRows).toBe(40);

      run.resolve(backupSummary);
      await pending;
      expect(listeners.backup).toHaveLength(0);
    });

    it("cancels the running backup by its id", async () => {
      const run = deferred<unknown>();
      api.backupDatabase.mockReturnValue(run.promise);
      const pending = useBackupStore.getState().runBackup(backupRequest);
      await flush();
      const id = useBackupStore.getState().backup.id;

      useBackupStore.getState().cancelBackup();

      expect(api.cancelBackup).toHaveBeenCalledWith(id);
      run.resolve(backupSummary);
      await pending;
    });

    it("keeps a running backup cancellable through a reset", async () => {
      const run = deferred<unknown>();
      api.backupDatabase.mockReturnValue(run.promise);
      const pending = useBackupStore.getState().runBackup(backupRequest);
      await flush();

      useBackupStore.getState().resetBackup();
      useBackupStore.getState().cancelBackup();

      expect(api.cancelBackup).toHaveBeenCalledTimes(1);
      run.resolve(backupSummary);
      await pending;
    });
  });

  describe("restores", () => {
    it("resolves to the summary and keeps it in the slot", async () => {
      api.restoreDatabase.mockResolvedValue(restoreSummary);

      const summary = await useBackupStore.getState().runRestore("restore", restoreRequest);

      expect(summary).toBe(restoreSummary);
      expect(useBackupStore.getState().restore).toMatchObject({ summary: restoreSummary, running: false });
      expect(useBackupStore.getState().import.summary).toBeNull();
    });

    it("resolves to null on failure, with the reason in the slot", async () => {
      api.restoreDatabase.mockRejectedValue("Access denied");

      const summary = await useBackupStore.getState().runRestore("import", restoreRequest);

      expect(summary).toBeNull();
      expect(useBackupStore.getState().import.error).toBe("Access denied");
    });

    it("follows only its own run's progress", async () => {
      const run = deferred<unknown>();
      api.restoreDatabase.mockReturnValue(run.promise);
      const pending = useBackupStore.getState().runRestore("restore", restoreRequest);
      await flush();
      const id = useBackupStore.getState().restore.id;

      listeners.restore.forEach((l) => l({ payload: { restoreId: "other", progress: { bytesRead: 9 } } }));
      expect(useBackupStore.getState().restore.progress).toBeNull();
      listeners.restore.forEach((l) => l({ payload: { restoreId: id, progress: { bytesRead: 5 } } }));
      expect(useBackupStore.getState().restore.progress).toEqual({ bytesRead: 5 });

      run.resolve(restoreSummary);
      await pending;
    });

    it("marks the slot cancelling until the run stops", async () => {
      const run = deferred<unknown>();
      api.restoreDatabase.mockReturnValue(run.promise);
      const pending = useBackupStore.getState().runRestore("import", restoreRequest);
      await flush();
      const id = useBackupStore.getState().import.id;

      useBackupStore.getState().cancelRestore("import");
      expect(api.cancelBackup).toHaveBeenCalledWith(id);
      expect(useBackupStore.getState().import.cancelling).toBe(true);

      run.resolve({ ...restoreSummary, cancelled: true });
      await pending;
      expect(useBackupStore.getState().import.cancelling).toBe(false);
    });

    it("does not cancel when nothing is running", () => {
      useBackupStore.getState().cancelRestore("restore");

      expect(api.cancelBackup).not.toHaveBeenCalled();
      expect(useBackupStore.getState().restore.cancelling).toBe(false);
    });

    it("previews a dump, clearing the last outcome", async () => {
      useBackupStore.setState({
        restore: { ...useBackupStore.getState().restore, error: "old", summary: restoreSummary as never },
      });
      api.readFileHead.mockResolvedValue({ text: "-- dump", totalBytes: 7, truncated: false });

      const head = await useBackupStore.getState().previewDump("restore", "/d.sql", 1024);

      expect(api.readFileHead).toHaveBeenCalledWith("/d.sql", 1024);
      expect(head).toEqual({ text: "-- dump", totalBytes: 7, truncated: false });
      expect(useBackupStore.getState().restore).toMatchObject({ error: null, summary: null });
    });

    it("says why a dump could not be previewed", async () => {
      api.readFileHead.mockRejectedValue("No such file");

      expect(await useBackupStore.getState().previewDump("restore", "/d.sql", 1024)).toBeNull();
      expect(useBackupStore.getState().restore.error).toBe("No such file");
    });
  });
});
