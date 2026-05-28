import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  generateBackup,
  defaultBackupOptions,
  escapeValue,
  escapeIdentifier,
  type BackupOptions,
  type BackupProgress,
} from "../backup-generator";

const mockGetTableDdl = vi.fn();
const mockExecuteQuery = vi.fn();
const mockGetViews = vi.fn();
const mockGetRoutines = vi.fn();
const mockGetTriggers = vi.fn();
const mockGetViewDdl = vi.fn();
const mockGetRoutineDdl = vi.fn();
const mockGetTriggerDdl = vi.fn();

vi.mock("../tauri-api", () => ({
  api: {
    getTableDdl: (...args: unknown[]) => mockGetTableDdl(...args),
    executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
    getViews: (...args: unknown[]) => mockGetViews(...args),
    getRoutines: (...args: unknown[]) => mockGetRoutines(...args),
    getTriggers: (...args: unknown[]) => mockGetTriggers(...args),
    getViewDdl: (...args: unknown[]) => mockGetViewDdl(...args),
    getRoutineDdl: (...args: unknown[]) => mockGetRoutineDdl(...args),
    getTriggerDdl: (...args: unknown[]) => mockGetTriggerDdl(...args),
  },
}));

function makeResult(rows: (string | number | null)[][], columns: string[]) {
  return {
    query_id: "q1",
    statement_index: 0,
    columns: columns.map((name) => ({
      name,
      data_type: "varchar",
      nullable: true,
      is_primary_key: false,
    })),
    rows: rows.map((row) => row.map((v) => (typeof v === "number" ? v : v))),
    rows_affected: 0,
    execution_time_ms: 1,
    warnings: [],
    rows_truncated: false,
  };
}

describe("generateBackup", () => {
  const connectionId = "conn-1";
  const database = "testdb";
  const tableNames = ["users"];

  beforeEach(() => {
    mockGetTableDdl.mockReset();
    mockExecuteQuery.mockReset();
    mockGetViews.mockReset();
    mockGetRoutines.mockReset();
    mockGetTriggers.mockReset();
    mockGetViewDdl.mockReset();
    mockGetRoutineDdl.mockReset();
    mockGetTriggerDdl.mockReset();
  });

  it("generates header with generation timestamp", async () => {
    mockGetTableDdl.mockResolvedValue("CREATE TABLE `users` (\n  `id` int\n)");
    mockExecuteQuery.mockResolvedValue([makeResult([], ["id"])]);

    const cancelRef = { current: false };
    const sql = await generateBackup(
      connectionId, database, tableNames,
      { ...defaultBackupOptions, includeData: false, includeViews: false, includeRoutines: false, includeTriggers: false },
      vi.fn(),
      cancelRef,
    );

    expect(sql).toContain("-- SQLPilot Database Backup");
    expect(sql).toContain("-- Generated:");
    expect(sql).toContain(`-- Database: ${database}`);
    expect(sql).toContain("/*!40101 SET @OLD_CHARACTER_SET_CLIENT");
    expect(sql).toContain("Backup completed:");
  });

  it("includes CREATE DATABASE when option is set", async () => {
    mockGetTableDdl.mockResolvedValue("CREATE TABLE `users` (\n  `id` int\n)");
    mockExecuteQuery.mockResolvedValue([makeResult([], ["id"])]);

    const options: BackupOptions = {
      ...defaultBackupOptions,
      includeCreateDatabase: true,
      includeData: false,
      includeViews: false,
      includeRoutines: false,
      includeTriggers: false,
    };

    const sql = await generateBackup(
      connectionId, database, tableNames, options, vi.fn(), { current: false },
    );

    expect(sql).toContain("CREATE DATABASE IF NOT EXISTS `testdb`");
    expect(sql).toContain("USE `testdb`");
  });

  it("includes DROP TABLE IF EXISTS when option is set", async () => {
    mockGetTableDdl.mockResolvedValue("CREATE TABLE `users` (\n  `id` int\n)");
    mockExecuteQuery.mockResolvedValue([makeResult([], ["id"])]);

    const options: BackupOptions = {
      ...defaultBackupOptions,
      dropTableIfExists: true,
      includeData: false,
      includeViews: false,
      includeRoutines: false,
      includeTriggers: false,
    };

    const sql = await generateBackup(
      connectionId, database, tableNames, options, vi.fn(), { current: false },
    );

    expect(sql).toContain("DROP TABLE IF EXISTS `users`");
  });

  it("excludes DROP TABLE IF EXISTS when option is false", async () => {
    mockGetTableDdl.mockResolvedValue("CREATE TABLE `users` (\n  `id` int\n)");
    mockExecuteQuery.mockResolvedValue([makeResult([], ["id"])]);

    const options: BackupOptions = {
      ...defaultBackupOptions,
      dropTableIfExists: false,
      includeData: false,
      includeViews: false,
      includeRoutines: false,
      includeTriggers: false,
    };

    const sql = await generateBackup(
      connectionId, database, tableNames, options, vi.fn(), { current: false },
    );

    expect(sql).not.toContain("DROP TABLE IF EXISTS");
  });

  it("strips AUTO_INCREMENT when includeAutoIncrement is false", async () => {
    mockGetTableDdl.mockResolvedValue("CREATE TABLE `users` (\n  `id` int\n) AUTO_INCREMENT=42");
    mockExecuteQuery.mockResolvedValue([makeResult([], ["id"])]);

    const options: BackupOptions = {
      ...defaultBackupOptions,
      includeAutoIncrement: false,
      includeData: false,
      includeViews: false,
      includeRoutines: false,
      includeTriggers: false,
    };

    const sql = await generateBackup(
      connectionId, database, tableNames, options, vi.fn(), { current: false },
    );

    expect(sql).not.toContain("AUTO_INCREMENT=42");
  });

  it("generates single-row INSERT statements", async () => {
    mockGetTableDdl.mockResolvedValue("CREATE TABLE `users` (\n  `id` int\n)");
    mockExecuteQuery.mockResolvedValue([
      makeResult(
        [
          ["alice", "alice@test.com"],
          ["bob", "bob@test.com"],
        ],
        ["name", "email"],
      ),
    ]);

    const options: BackupOptions = {
      ...defaultBackupOptions,
      multiRowInserts: false,
      includeViews: false,
      includeRoutines: false,
      includeTriggers: false,
    };

    const sql = await generateBackup(
      connectionId, database, tableNames, options, vi.fn(), { current: false },
    );

    expect(sql).toContain("INSERT INTO `users` (`name`, `email`) VALUES ('alice', 'alice@test.com');");
    expect(sql).toContain("INSERT INTO `users` (`name`, `email`) VALUES ('bob', 'bob@test.com');");
  });

  it("generates multi-row INSERT statements", async () => {
    mockGetTableDdl.mockResolvedValue("CREATE TABLE `users` (\n  `id` int\n)");
    mockExecuteQuery.mockResolvedValue([
      makeResult(
        [
          ["alice", "alice@test.com"],
          ["bob", "bob@test.com"],
        ],
        ["name", "email"],
      ),
    ]);

    const options: BackupOptions = {
      ...defaultBackupOptions,
      multiRowInserts: true,
      insertBatchSize: 10,
      includeViews: false,
      includeRoutines: false,
      includeTriggers: false,
    };

    const sql = await generateBackup(
      connectionId, database, tableNames, options, vi.fn(), { current: false },
    );

    expect(sql).toContain("INSERT INTO `users` (`name`, `email`) VALUES");
    expect(sql).toContain("('alice', 'alice@test.com'),\n('bob', 'bob@test.com');");
  });

  it("batches multi-row inserts by insertBatchSize", async () => {
    mockGetTableDdl.mockResolvedValue("CREATE TABLE `users` (\n  `id` int\n)");
    // Return 3 rows, batch size = 2
    mockExecuteQuery.mockResolvedValue([
      makeResult(
        [
          ["a"],
          ["b"],
          ["c"],
        ],
        ["col"],
      ),
    ]);

    const options: BackupOptions = {
      ...defaultBackupOptions,
      multiRowInserts: true,
      insertBatchSize: 2,
      includeViews: false,
      includeRoutines: false,
      includeTriggers: false,
    };

    const sql = await generateBackup(
      connectionId, database, tableNames, options, vi.fn(), { current: false },
    );

    // Should have 2 INSERT statements: one with 2 rows, one with 1
    const insertMatches = sql.match(/INSERT INTO/g);
    expect(insertMatches).not.toBeNull();
    expect(insertMatches!.length).toBe(2);
  });

  it("adds LOCK/UNLOCK TABLES when addTableLocks is true", async () => {
    mockGetTableDdl.mockResolvedValue("CREATE TABLE `users` (\n  `id` int\n)");
    mockExecuteQuery.mockResolvedValue([makeResult([["a"]], ["col"])]);

    const options: BackupOptions = {
      ...defaultBackupOptions,
      addTableLocks: true,
      multiRowInserts: true,
      insertBatchSize: 10,
      includeViews: false,
      includeRoutines: false,
      includeTriggers: false,
    };

    const sql = await generateBackup(
      connectionId, database, tableNames, options, vi.fn(), { current: false },
    );

    expect(sql).toContain("LOCK TABLES `users` WRITE;");
    expect(sql).toContain("UNLOCK TABLES;");
  });

  it("calls progress callback during table backup", async () => {
    mockGetTableDdl.mockResolvedValue("CREATE TABLE `users` (\n  `id` int\n)");
    mockExecuteQuery.mockResolvedValue([makeResult([["a"]], ["col"])]);

    const onProgress = vi.fn();
    const options: BackupOptions = {
      ...defaultBackupOptions,
      multiRowInserts: false,
      includeViews: false,
      includeRoutines: false,
      includeTriggers: false,
    };

    await generateBackup(
      connectionId, database, tableNames, options, onProgress, { current: false },
    );

    expect(onProgress).toHaveBeenCalled();
    const firstCall = onProgress.mock.calls[0]?.[0] as BackupProgress;
    expect(firstCall.phase).toBe("Backing up tables");
    expect(firstCall.tableName).toBe("users");
    expect(firstCall.currentTable).toBe(1);
    expect(firstCall.totalTables).toBe(1);
  });

  it("stops early when cancelled via cancelRef", async () => {
    mockGetTableDdl.mockResolvedValue("CREATE TABLE `users` (\n  `id` int\n)");
    mockExecuteQuery.mockResolvedValue([makeResult([["a"]], ["col"])]);

    const cancelRef = { current: true };
    const sql = await generateBackup(
      connectionId, database, ["users", "orders"], defaultBackupOptions, vi.fn(), cancelRef,
    );

    // Should only have header, no table data
    expect(sql).toContain("-- SQLPilot Database Backup");
    expect(sql).not.toContain("-- Table:");
  });

  it("exports views when includeViews is true and views exist", async () => {
    mockGetTableDdl.mockResolvedValue("CREATE TABLE `users` (\n  `id` int\n)");
    mockExecuteQuery.mockResolvedValue([makeResult([], ["id"])]);
    mockGetViews.mockResolvedValue([{ name: "user_view" }]);
    mockGetViewDdl.mockResolvedValue("CREATE VIEW `user_view` AS SELECT * FROM `users`");

    const options: BackupOptions = {
      ...defaultBackupOptions,
      includeViews: true,
      includeData: false,
      includeRoutines: false,
      includeTriggers: false,
    };

    const sql = await generateBackup(
      connectionId, database, tableNames, options, vi.fn(), { current: false },
    );

    expect(sql).toContain("-- Views");
    expect(sql).toContain("CREATE VIEW `user_view`");
    expect(sql).toContain("DROP VIEW IF EXISTS `user_view`");
  });

  it("does not export views when includeViews is false", async () => {
    mockGetTableDdl.mockResolvedValue("CREATE TABLE `users` (\n  `id` int\n)");
    mockExecuteQuery.mockResolvedValue([makeResult([], ["id"])]);

    const options: BackupOptions = {
      ...defaultBackupOptions,
      includeViews: false,
      includeData: false,
      includeRoutines: false,
      includeTriggers: false,
    };

    const sql = await generateBackup(
      connectionId, database, tableNames, options, vi.fn(), { current: false },
    );

    expect(sql).not.toContain("-- Views");
  });

  it("handles view DDL fetch errors gracefully", async () => {
    mockGetTableDdl.mockResolvedValue("CREATE TABLE `users` (\n  `id` int\n)");
    mockExecuteQuery.mockResolvedValue([makeResult([], ["id"])]);
    mockGetViews.mockResolvedValue([{ name: "broken_view" }]);
    mockGetViewDdl.mockRejectedValue(new Error("Permission denied"));

    const options: BackupOptions = {
      ...defaultBackupOptions,
      includeViews: true,
      includeData: false,
      includeRoutines: false,
      includeTriggers: false,
    };

    const sql = await generateBackup(
      connectionId, database, tableNames, options, vi.fn(), { current: false },
    );

    expect(sql).toContain("-- Error getting view broken_view");
  });

  it("exports routines when includeRoutines is true", async () => {
    mockGetTableDdl.mockResolvedValue("CREATE TABLE `users` (\n  `id` int\n)");
    mockExecuteQuery.mockResolvedValue([makeResult([], ["id"])]);
    mockGetRoutines.mockResolvedValue([
      { name: "my_proc", routine_type: "PROCEDURE" },
      { name: "my_func", routine_type: "FUNCTION" },
    ]);
    mockGetRoutineDdl
      .mockResolvedValueOnce("CREATE PROCEDURE `my_proc`() BEGIN END")
      .mockResolvedValueOnce("CREATE FUNCTION `my_func`() RETURNS INT BEGIN RETURN 1; END");

    const options: BackupOptions = {
      ...defaultBackupOptions,
      includeRoutines: true,
      includeData: false,
      includeViews: false,
      includeTriggers: false,
    };

    const sql = await generateBackup(
      connectionId, database, tableNames, options, vi.fn(), { current: false },
    );

    expect(sql).toContain("-- Routines");
    expect(sql).toContain("DROP PROCEDURE IF EXISTS `my_proc`");
    expect(sql).toContain("DROP FUNCTION IF EXISTS `my_func`");
    expect(sql).toContain("DELIMITER ;;");
    expect(sql).toContain("DELIMITER ;");
  });

  it("exports triggers when includeTriggers is true", async () => {
    mockGetTableDdl.mockResolvedValue("CREATE TABLE `users` (\n  `id` int\n)");
    mockExecuteQuery.mockResolvedValue([makeResult([], ["id"])]);
    mockGetTriggers.mockResolvedValue([{ name: "trg_before_insert", timing: "BEFORE", event: "INSERT" }]);
    mockGetTriggerDdl.mockResolvedValue("CREATE TRIGGER `trg_before_insert` BEFORE INSERT ON `users` FOR EACH ROW BEGIN END");

    const options: BackupOptions = {
      ...defaultBackupOptions,
      includeTriggers: true,
      includeData: false,
      includeViews: false,
      includeRoutines: false,
    };

    const sql = await generateBackup(
      connectionId, database, tableNames, options, vi.fn(), { current: false },
    );

    expect(sql).toContain("-- Triggers");
    expect(sql).toContain("DROP TRIGGER IF EXISTS `trg_before_insert`");
  });

  it("skips routines when includeRoutines is false", async () => {
    mockGetTableDdl.mockResolvedValue("CREATE TABLE `users` (\n  `id` int\n)");
    mockExecuteQuery.mockResolvedValue([makeResult([], ["id"])]);

    const options: BackupOptions = {
      ...defaultBackupOptions,
      includeRoutines: false,
      includeViews: false,
      includeTriggers: false,
      includeData: false,
    };

    const sql = await generateBackup(
      connectionId, database, tableNames, options, vi.fn(), { current: false },
    );

    expect(sql).not.toContain("-- Routines");
    expect(mockGetRoutines).not.toHaveBeenCalled();
  });

  it("skips triggers when includeTriggers is false", async () => {
    mockGetTableDdl.mockResolvedValue("CREATE TABLE `users` (\n  `id` int\n)");
    mockExecuteQuery.mockResolvedValue([makeResult([], ["id"])]);

    const options: BackupOptions = {
      ...defaultBackupOptions,
      includeTriggers: false,
      includeViews: false,
      includeRoutines: false,
      includeData: false,
    };

    const sql = await generateBackup(
      connectionId, database, tableNames, options, vi.fn(), { current: false },
    );

    expect(mockGetTriggers).not.toHaveBeenCalled();
  });

  it("processes multiple tables in order", async () => {
    mockGetTableDdl
      .mockResolvedValueOnce("CREATE TABLE `users` (\n  `id` int\n)")
      .mockResolvedValueOnce("CREATE TABLE `orders` (\n  `id` int\n)");
    mockExecuteQuery
      .mockResolvedValueOnce([makeResult([], ["id"])])
      .mockResolvedValueOnce([makeResult([], ["id"])]);

    const sql = await generateBackup(
      connectionId, database, ["users", "orders"],
      { ...defaultBackupOptions, includeData: false, includeViews: false, includeRoutines: false, includeTriggers: false },
      vi.fn(),
      { current: false },
    );

    const usersIdx = sql.indexOf("-- Table: `users`");
    const ordersIdx = sql.indexOf("-- Table: `orders`");
    expect(usersIdx).toBeLessThan(ordersIdx);
  });

  it("passes progress callback with rowsExported for data export", async () => {
    mockGetTableDdl.mockResolvedValue("CREATE TABLE `users` (\n  `id` int\n)");
    mockExecuteQuery.mockResolvedValue([
      makeResult(
        [["alice"], ["bob"], ["charlie"]],
        ["name"],
      ),
    ]);

    const progressCalls: BackupProgress[] = [];
    const onProgress = (p: BackupProgress) => progressCalls.push(p);
    const options: BackupOptions = {
      ...defaultBackupOptions,
      multiRowInserts: false,
      insertBatchSize: 10,
      includeViews: false,
      includeRoutines: false,
      includeTriggers: false,
    };

    const sql = await generateBackup(
      connectionId, database, tableNames, options, onProgress, { current: false },
    );

    // Should have INSERT statements
    expect(sql).toContain("INSERT INTO");

    expect(progressCalls.length).toBeGreaterThanOrEqual(1);
    const lastCall = progressCalls[progressCalls.length - 1];
    expect(lastCall.rowsExported).toBe(3);
  });

  it("handles empty view/routine/trigger lists", async () => {
    mockGetTableDdl.mockResolvedValue("CREATE TABLE `users` (\n  `id` int\n)");
    mockExecuteQuery.mockResolvedValue([makeResult([], ["id"])]);
    mockGetViews.mockResolvedValue([]);
    mockGetRoutines.mockResolvedValue([]);
    mockGetTriggers.mockResolvedValue([]);

    const options: BackupOptions = {
      ...defaultBackupOptions,
      includeViews: true,
      includeRoutines: true,
      includeTriggers: true,
      includeData: false,
    };

    const sql = await generateBackup(
      connectionId, database, tableNames, options, vi.fn(), { current: false },
    );

    expect(sql).not.toContain("-- Views");
    expect(sql).not.toContain("-- Routines");
    expect(sql).not.toContain("-- Triggers");
    expect(sql).toContain("-- Table:");
  });
});

describe("escapeValue", () => {
  it("returns NULL for null", () => {
    expect(escapeValue(null)).toBe("NULL");
  });

  it("returns number as string", () => {
    expect(escapeValue(42)).toBe("42");
    expect(escapeValue(0)).toBe("0");
  });

  it("returns 1/0 for booleans", () => {
    expect(escapeValue(true)).toBe("1");
    expect(escapeValue(false)).toBe("0");
  });

  it("returns hex for binary arrays", () => {
    expect(escapeValue([72, 101])).toBe("X'4865'");
  });

  it("escapes single quotes and backslashes", () => {
    expect(escapeValue("it's ok")).toBe("'it\\'s ok'");
    expect(escapeValue("a\\b")).toBe("'a\\\\b'");
  });

  it("escapes special chars", () => {
    expect(escapeValue("a\nb")).toBe("'a\\nb'");
    expect(escapeValue("a\rb")).toBe("'a\\rb'");
    expect(escapeValue("a\x00b")).toBe("'a\\0b'");
    expect(escapeValue("a\x1ab")).toBe("'a\\Zb'");
  });
});

describe("escapeIdentifier", () => {
  it("wraps in backticks", () => {
    expect(escapeIdentifier("users")).toBe("`users`");
  });

  it("doubles backticks inside", () => {
    expect(escapeIdentifier("a`b")).toBe("`a``b`");
  });
});
