// Files, file dialogs, and the streaming backup and restore.
//
// There is no disk in a browser, so a small in-memory file system stands in
// for one: a few fixtures under one placeholder directory, plus whatever the
// app writes during the session. A backup written here can be restored or
// previewed afterwards, which is the round trip worth reviewing.
//
// Backup and restore run for about three seconds of real time but report a
// virtual clock, so the rates and "time left" read like a real dump of tables
// this size rather than millions of rows a second.

import { emit } from "@tauri-apps/api/event";
import type {
  BackupOptions,
  BackupProgress,
  BackupProgressEvent,
  BackupSummary,
  FileHead,
  RestoreOptions,
  RestoreProgressEvent,
  RestoreSummary,
  SqlValue,
} from "../../../lib/bindings";
import { DATABASES, findTable, PROFILES, rand, tableRows } from "../dataset";
import { delay, fail, type Handlers } from "../router";
import { liveConnection } from "../state";
import { createTableDdl } from "./schema";

/** Where every picked or saved file lives. A placeholder, not anyone's home. */
const DIR = "/tmp/sqlpilot-mock";

// ---------------------------------------------------------------- fixtures

function sqlLiteral(v: SqlValue): string {
  if (v === null || v === "Null") return "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return `X'${v.map((b) => b.toString(16).padStart(2, "0")).join("")}'`;
  return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** The head of a dump as SQLPilot writes one: header, then table by table. */
function dumpText(database: string, rowsPerTable = 25): string {
  const db = DATABASES.find((d) => d.name === database);
  const out = [
    "-- SQLPilot SQL dump",
    `-- Database: \`${database}\``,
    "-- Server version: 8.0.39",
    "-- Generated: 2026-10-18 02:00:04 UTC",
    "",
    "SET NAMES utf8mb4;",
    "SET FOREIGN_KEY_CHECKS = 0;",
    "SET UNIQUE_CHECKS = 0;",
    "",
    "-- Read from a single consistent snapshot.",
    "",
  ];
  for (const table of db?.tables.filter((t) => t.table_type === "BASE TABLE") ?? []) {
    out.push("--", `-- Table: \`${table.name}\``, "--", "");
    out.push(`DROP TABLE IF EXISTS \`${table.name}\`;`, `${createTableDdl(database, table)};`, "");
    const cols = table.columns.map((c) => `\`${c.name}\``).join(", ");
    const rows = tableRows(table, 0, rowsPerTable).map((r) => `(${r.map(sqlLiteral).join(", ")})`);
    if (rows.length) out.push(`INSERT INTO \`${table.name}\` (${cols}) VALUES\n${rows.join(",\n")};`, "");
  }
  out.push("SET FOREIGN_KEY_CHECKS = 1;", "SET UNIQUE_CHECKS = 1;", "");
  return out.join("\n");
}

function csvText(): string {
  const table = findTable("shop", "customers");
  if (!table) return "";
  const cell = (v: SqlValue) => {
    if (v === null || v === "Null") return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
  };
  // No id: the column the table fills in itself, as an export to re-import
  // usually leaves out.
  const cols = table.columns.filter((c) => c.name !== "id");
  const lines = [cols.map((c) => c.name).join(",")];
  for (let i = 1300; i < 1420; i++) lines.push(cols.map((c) => cell(c.gen(i))).join(","));
  return `${lines.join("\n")}\n`;
}

const FAVORITES_JSON = JSON.stringify(
  {
    kind: "sqlpilot-favorites",
    version: 1,
    exportedAt: "2026-10-02T08:30:00.000Z",
    categories: ["Reports"],
    favorites: [
      {
        id: "fav-import-1",
        name: "Revenue by month",
        sql:
          "SELECT DATE_FORMAT(placed_at, '%Y-%m') AS month, SUM(total) AS revenue\nFROM orders\nWHERE status <> 'refunded'\nGROUP BY month\nORDER BY month DESC;",
        category: "Reports",
        connectionName: "Local dev",
        database: "shop",
        createdAt: "2026-09-14T10:02:00.000Z",
        updatedAt: "2026-09-14T10:02:00.000Z",
      },
      {
        id: "fav-import-2",
        name: "Top customers",
        sql: "SELECT customer_id, lifetime_value FROM order_totals ORDER BY lifetime_value DESC LIMIT 20;",
        category: "Reports",
        createdAt: "2026-09-20T15:40:00.000Z",
        updatedAt: "2026-09-20T15:40:00.000Z",
      },
    ],
  },
  null,
  2,
);

interface MockFile {
  text: string;
  /** What the file system would report. The text is only its head for a dump. */
  size: number;
}

const files = new Map<string, MockFile>();

function seedFiles(): void {
  const csv = csvText();
  files.set(`${DIR}/shop_backup.sql`, { text: dumpText("shop"), size: 48_734_208 });
  files.set(`${DIR}/customers.csv`, { text: csv, size: csv.length });
  files.set(`${DIR}/sqlpilot-favorites.json`, { text: FAVORITES_JSON, size: FAVORITES_JSON.length });
  // Opened by the SQLite handlers; it only has to exist here for a preview.
  files.set(`${DIR}/inventory.sqlite`, { text: "SQLite format 3\u0000", size: 241_664 });
}
seedFiles();

function readFile(path: unknown): MockFile {
  const file = files.get(String(path));
  if (!file) fail(`Could not read ${String(path)}: No such file or directory (os error 2)`);
  return file;
}

/** The fixture a picker with these filters would most plausibly land on. */
function pickedPath(filters: unknown): string {
  const exts = Array.isArray(filters)
    ? filters.flatMap((f) => (Array.isArray(f) && Array.isArray(f[1]) ? (f[1] as unknown[]).map(String) : []))
    : [];
  if (exts.includes("csv")) return `${DIR}/customers.csv`;
  if (exts.includes("json")) return `${DIR}/sqlpilot-favorites.json`;
  if (exts.some((e) => ["db", "sqlite", "sqlite3"].includes(e))) return `${DIR}/inventory.sqlite`;
  return `${DIR}/shop_backup.sql`;
}

// ---------------------------------------------------------------- jobs

/** Cancel flags for running backups and restores, by the caller's id. */
const running = new Map<string, { cancelled: boolean }>();

function register(id: string, kind: "backup" | "job"): { cancelled: boolean } {
  if (running.has(id)) {
    fail(kind === "backup" ? `A backup with id ${id} is already running` : `A job with id ${id} is already running`);
  }
  const flag = { cancelled: false };
  running.set(id, flag);
  return flag;
}

/** Real time between progress events, and the real length of a whole run. */
const TICK_MS = 150;
const RUN_MS = 3000;
/** The virtual dump rate: a plausible single-connection mysqldump speed. */
const ROWS_PER_SECOND = 85_000;

interface Step {
  phase: string;
  tableName: string;
  currentTable: number;
  rows: number;
  bytesPerRow: number;
  /** Virtual milliseconds this step takes. */
  virtualMs: number;
  estimatedRows: number | null;
}

function backupSteps(database: string, tables: string[], options: BackupOptions): Step[] {
  const steps: Step[] = tables.map((name, i) => {
    const table = findTable(database, name);
    const rows = options.includeData ? (table?.rowCount ?? 0) : 0;
    return {
      phase: "Backing up tables",
      tableName: name,
      currentTable: i + 1,
      rows,
      bytesPerRow: 40 + (table?.columns.length ?? 4) * 14,
      virtualMs: 120 + (rows / ROWS_PER_SECOND) * 1000,
      estimatedRows: table ? table.rowCount : null,
    };
  });
  const db = DATABASES.find((d) => d.name === database);
  const last = tables.length;
  const extra = (phase: string, tableName: string): Step => ({
    phase,
    tableName,
    currentTable: last,
    rows: 0,
    bytesPerRow: 0,
    virtualMs: 90,
    estimatedRows: null,
  });
  if (options.includeViews) {
    for (const v of db?.tables.filter((t) => t.table_type === "VIEW") ?? []) {
      steps.push(extra("Backing up views", v.name));
    }
  }
  if (options.includeRoutines) steps.push(extra("Backing up routines", ""));
  if (options.includeTriggers) steps.push(extra("Backing up triggers", ""));
  return steps;
}

async function runBackup(args: Record<string, unknown>): Promise<BackupSummary> {
  liveConnection(args.connectionId);
  const backupId = String(args.backupId);
  const database = String(args.database);
  const tables = Array.isArray(args.tables) ? args.tables.map(String) : [];
  const options = args.options as BackupOptions;
  const outputPath = String(args.outputPath);
  const flag = register(backupId, "backup");

  try {
    const steps = backupSteps(database, tables, options);
    // Each step's share of the three seconds grows with its virtual length,
    // but slower than linearly, so a small table is still seen going by.
    const weights = steps.map((s) => Math.sqrt(s.virtualMs));
    const total = weights.reduce((a, b) => a + b, 0) || 1;

    let rowsDone = 0;
    let bytes = 0;
    let virtualElapsed = 0;
    let tablesDone = 0;
    let tick = 0;
    const warnings: string[] = [];

    const send = (step: Step, rowsPerSecond: number | null) => {
      const progress: BackupProgress = {
        phase: step.phase,
        currentTable: step.currentTable,
        totalTables: tables.length,
        tableName: step.tableName,
        rowsExported: rowsDone,
        bytesWritten: bytes,
        elapsedMs: Math.round(virtualElapsed),
        rowsPerSecond,
        estimatedRows: step.estimatedRows,
      };
      const payload: BackupProgressEvent = { backupId, progress };
      return emit("backup-progress-event", payload);
    };

    for (const [i, step] of steps.entries()) {
      if (flag.cancelled) break;
      if (options.includeStructure) bytes += 1_400;
      await send(step, null);
      const ticks = Math.max(2, Math.round((RUN_MS * weights[i]) / total / TICK_MS));
      let stepRows = 0;
      for (let t = 1; t <= ticks && !flag.cancelled; t++) {
        await delay(TICK_MS);
        // A rate that wanders a little, as a real one does.
        const share = (step.virtualMs / ticks) * (0.85 + rand(tick++, 31) * 0.3);
        const target = t === ticks ? step.rows : Math.min(step.rows, Math.round((step.rows * t) / ticks));
        const delta = target - stepRows;
        stepRows = target;
        rowsDone += delta;
        bytes += delta * step.bytesPerRow;
        virtualElapsed += share;
        await send(step, step.rows > 0 ? (delta / share) * 1000 : null);
      }
      if (!flag.cancelled && step.phase === "Backing up tables") tablesDone++;
      // The view's definer was dropped, so SHOW CREATE VIEW fails: the one
      // non-fatal problem a dump of this fixture reports.
      if (step.phase === "Backing up views" && step.tableName === "order_totals" && !flag.cancelled) {
        warnings.push(
          "View `order_totals` was skipped: its definer 'reporting'@'%' no longer exists (1449). Recreate it with a valid DEFINER to include it.",
        );
      }
    }

    if (flag.cancelled) {
      // The backend deletes the partial file, so nothing can pass for a backup.
      files.delete(outputPath);
    } else {
      files.set(outputPath, { text: dumpText(database), size: bytes });
    }
    return {
      bytesWritten: bytes,
      rowsExported: rowsDone,
      tables: tablesDone,
      elapsedMs: Math.round(virtualElapsed),
      cancelled: flag.cancelled,
      warnings,
    };
  } finally {
    running.delete(backupId);
  }
}

/** Virtual bytes a second for a restore: statement execution, not disk. */
const RESTORE_BYTES_PER_SECOND = 9 * 1024 * 1024;
/** Average statement size in a multi-row dump. */
const BYTES_PER_STATEMENT = 14_000;

async function runRestore(args: Record<string, unknown>): Promise<RestoreSummary> {
  const conn = liveConnection(args.connectionId);
  const restoreId = String(args.restoreId);
  const options = args.options as RestoreOptions;
  const file = readFile(args.inputPath);
  const flag = register(restoreId, "job");

  try {
    // The read-only production login is refused by the server on the first
    // write, which is the restore's failure path worth seeing.
    const readOnly = PROFILES.find((p) => p.id === conn.profile_id)?.read_only === true;
    const ticks = Math.round(RUN_MS / TICK_MS);
    let run = 0;
    let failedCount = 0;
    let bytesRead = 0;
    let elapsed = 0;
    let committedSomething = false;
    const errors: string[] = [];

    const send = () => {
      const payload: RestoreProgressEvent = {
        restoreId,
        progress: {
          statementsRun: run,
          statementsFailed: failedCount,
          bytesRead,
          totalBytes: file.size,
          elapsedMs: Math.round(elapsed),
        },
      };
      return emit("restore-progress-event", payload);
    };

    for (let t = 1; t <= ticks && !flag.cancelled; t++) {
      await delay(TICK_MS);
      const chunk = t === ticks ? file.size - bytesRead : Math.round(file.size / ticks);
      bytesRead += chunk;
      elapsed += (chunk / RESTORE_BYTES_PER_SECOND) * 1000 * (0.9 + rand(t, 41) * 0.2);
      const statements = Math.max(1, Math.round(chunk / BYTES_PER_STATEMENT));
      if (readOnly) {
        const failing = options.stopOnError ? 1 : statements;
        failedCount += failing;
        // Numbered by statements run so far, as the backend does, so with
        // nothing succeeding every line says "Statement 1".
        for (let s = 0; s < failing && errors.length < 100; s++) {
          errors.push(
            `Statement ${
              run + 1
            }: error returned from database: 1290 (HY000): The MySQL server is running with the --read-only option so it cannot execute this statement`,
          );
        }
        if (options.stopOnError) break;
      } else {
        run += statements;
        // The file opens with DROP and CREATE, which commit as they run.
        committedSomething = true;
      }
      await send();
    }
    await send();

    const cancelled = flag.cancelled;
    const failed = failedCount > 0;
    const rolledBack = options.wrapInTransaction && (cancelled || (failed && options.stopOnError));
    return {
      statementsRun: run,
      statementsFailed: failedCount,
      bytesRead,
      elapsedMs: Math.round(elapsed),
      cancelled,
      rolledBack,
      // Nothing ran, so nothing can have been applied: with every statement
      // refused (read-only production, Stop on error off) the summary must
      // not tell the user their database is half-restored.
      partiallyApplied: run > 0 && (cancelled || failed) && (!rolledBack || committedSomething),
      errors,
    };
  } finally {
    running.delete(restoreId);
  }
}

// ---------------------------------------------------------------- handlers

export const fileHandlers: Handlers = {
  pick_file: async ({ filters }) => {
    await delay(200);
    return pickedPath(filters);
  },
  pick_save_file: async ({ defaultName }) => {
    await delay(200);
    // The name the app suggested, minus anything that would leave the directory.
    const name = String(defaultName ?? "untitled").split(/[\\/]/).pop() || "untitled";
    return `${DIR}/${name}`;
  },
  read_file_contents: async ({ path }) => {
    await delay(80);
    return readFile(path).text;
  },
  read_file_head: async ({ path, maxBytes }): Promise<FileHead> => {
    await delay(80);
    const file = readFile(path);
    const text = file.text.slice(0, Number(maxBytes) || 0);
    return { text, totalBytes: file.size, truncated: file.size > text.length };
  },
  write_file_contents: async ({ path, contents }) => {
    await delay(80);
    const text = String(contents ?? "");
    files.set(String(path), { text, size: text.length });
    return null;
  },
  default_backup_options: (): BackupOptions => ({
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
  }),
  default_restore_options: (): RestoreOptions => ({
    stopOnError: true,
    disableForeignKeyChecks: true,
    wrapInTransaction: true,
  }),
  backup_database: (args) => runBackup(args),
  restore_database: (args) => runRestore(args),
  // Whether there was one to stop. A late Cancel is not an error.
  cancel_backup: ({ backupId }) => {
    const flag = running.get(String(backupId));
    if (!flag) return false;
    flag.cancelled = true;
    return true;
  },
};
