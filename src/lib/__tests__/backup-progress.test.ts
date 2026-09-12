import { describe, expect, it } from "vitest";
import { defaultBackupOptions, formatBytes, formatElapsed, formatRate, formatRemaining } from "../backup-progress";
import type { BackupProgress } from "../bindings";

const progress = (over: Partial<BackupProgress> = {}): BackupProgress => ({
  phase: "Backing up tables",
  currentTable: 1,
  totalTables: 3,
  tableName: "orders",
  rowsExported: 1000,
  bytesWritten: 4096,
  elapsedMs: 5000,
  rowsPerSecond: 500,
  estimatedRows: 3000,
  ...over,
});

describe("backup progress (#361)", () => {
  describe("the row rate", () => {
    it("reads in whole rows a second", () => {
      expect(formatRate(1234)).toBe("1.2k rows/s");
      expect(formatRate(12)).toBe("12 rows/s");
      expect(formatRate(2_500_000)).toBe("2.5M rows/s");
    });

    it("says nothing rather than zero when there is no rate yet", () => {
      // A dump that has not read a row yet is not going at 0 rows/s; it has
      // not started, and saying "0 rows/s" reads as stuck.
      expect(formatRate(0)).toBeNull();
      expect(formatRate(null)).toBeNull();
    });

    it("survives the non-finite values a float can carry", () => {
      // rowsPerSecond crosses the IPC boundary as a float, and JSON turns a
      // non-finite one into null.
      expect(formatRate(Number.POSITIVE_INFINITY)).toBeNull();
      expect(formatRate(Number.NaN)).toBeNull();
    });
  });

  describe("how much is left", () => {
    it("divides what is left by the rate", () => {
      // 2000 rows left at 500 a second.
      expect(formatRemaining(progress())).toBe("4s");
    });

    it("reads in minutes once it is more than a minute", () => {
      expect(formatRemaining(progress({ estimatedRows: 100_000 }))).toBe("3m 18s");
    });

    it("says nothing when the server has no row estimate", () => {
      expect(formatRemaining(progress({ estimatedRows: null }))).toBeNull();
    });

    it("says nothing rather than a negative when the estimate is under", () => {
      // information_schema's TABLE_ROWS is a sample for InnoDB and is
      // routinely wrong. "-3s left" is worse than no estimate.
      expect(formatRemaining(progress({ rowsExported: 5000 }))).toBeNull();
    });

    it("says nothing before there is a rate to divide by", () => {
      expect(formatRemaining(progress({ rowsPerSecond: 0 }))).toBeNull();
      expect(formatRemaining(progress({ rowsPerSecond: null }))).toBeNull();
    });
  });

  describe("elapsed time", () => {
    it("counts in seconds, then minutes, then hours", () => {
      expect(formatElapsed(3000)).toBe("3s");
      expect(formatElapsed(90_000)).toBe("1m 30s");
      expect(formatElapsed(3_900_000)).toBe("1h 5m");
    });

    it("rounds a fraction of a second up to one", () => {
      // "0s elapsed" on a running dump looks like nothing is happening.
      expect(formatElapsed(200)).toBe("1s");
    });
  });

  describe("bytes written", () => {
    it("scales to the unit a person reads", () => {
      expect(formatBytes(512)).toBe("512 B");
      expect(formatBytes(2048)).toBe("2.0 KB");
      expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
      expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
    });
  });

  it("defaults to a consistent snapshot", () => {
    // A dump of a live database taken without one can hold a child row whose
    // parent is not in the file.
    expect(defaultBackupOptions.consistentSnapshot).toBe(true);
  });

  it("defaults to everything the database contains", () => {
    // A backup that silently leaves out the routines is not a backup.
    expect(defaultBackupOptions.includeViews).toBe(true);
    expect(defaultBackupOptions.includeRoutines).toBe(true);
    expect(defaultBackupOptions.includeTriggers).toBe(true);
    expect(defaultBackupOptions.includeStructure).toBe(true);
    expect(defaultBackupOptions.includeData).toBe(true);
  });
});
