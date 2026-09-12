import type { BackupOptions, BackupProgress } from "./bindings";

/**
 * What the backup dialog starts from.
 *
 * The same values as `BackupOptions::default()` in Rust, which is where the
 * dump reads them. Duplicated rather than fetched because the dialog has to
 * draw its checkboxes before any command has been called; the test below
 * fails if the two lists ever disagree in shape.
 */
export const defaultBackupOptions: BackupOptions = {
  includeStructure: true,
  includeData: true,
  dropTableIfExists: true,
  includeCreateDatabase: false,
  addTableLocks: false,
  includeAutoIncrement: true,
  includeViews: true,
  includeRoutines: true,
  includeTriggers: true,
  multiRowInserts: true,
  insertBatchSize: 100,
  consistentSnapshot: true,
};

/**
 * A row rate, for someone watching a dump that has been running for a while.
 *
 * The dialog used to show a table counter and nothing else, so a single large
 * table looked identical to a hung one from the first row to the last (#361).
 */
export function formatRate(rowsPerSecond: number | null): string | null {
  if (rowsPerSecond === null || !Number.isFinite(rowsPerSecond) || rowsPerSecond <= 0) {
    return null;
  }
  if (rowsPerSecond >= 1_000_000) return `${(rowsPerSecond / 1_000_000).toFixed(1)}M rows/s`;
  if (rowsPerSecond >= 1_000) return `${(rowsPerSecond / 1_000).toFixed(1)}k rows/s`;
  return `${Math.round(rowsPerSecond).toLocaleString()} rows/s`;
}

/**
 * How long the current table has left, from the server's row estimate.
 *
 * Null rather than a guess when there is nothing to divide by. An estimate
 * that is wrong in the first second is worse than no estimate: people stop
 * believing the next one.
 */
export function formatRemaining(progress: BackupProgress): string | null {
  const { estimatedRows, rowsExported, rowsPerSecond } = progress;
  if (!estimatedRows || !rowsPerSecond || rowsPerSecond <= 0) return null;
  const left = estimatedRows - rowsExported;
  // The estimate is `information_schema`'s, which for InnoDB is a sample and
  // can be under the real count. Past it, say nothing rather than "-3s".
  if (left <= 0) return null;
  return formatDuration(left / rowsPerSecond);
}

/** Elapsed time, for the same reason. */
export function formatElapsed(elapsedMs: number): string {
  return formatDuration(elapsedMs / 1000);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Bytes written so far, in the units a person reads. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
