import { useConnectionStore } from "../stores/connectionStore";
import { useHistoryStore } from "../stores/historyStore";
import type { QueryResult } from "../types";
import { api, CommandError } from "./tauri-api";

/**
 * Where a statement came from.
 *
 * Only editor queries were ever recorded, so which statements appeared in
 * history was an accident of which call sites had been refactored rather than
 * a decision (#586). Everything is recorded now and tagged, which is what lets
 * the panel show the user's own work by default without hiding the rest.
 */
export type StatementOrigin =
  | "editor"
  | "grid"
  | "designer"
  | "routine"
  | "admin"
  /** Schema-tree menus: DROP, TRUNCATE, RENAME and the rest (#293). */
  | "schema"
  | "import"
  | "restore"
  /** Reads the app makes on the user's behalf, never shown by default. */
  | "internal";

/** Origins the panel shows unless asked for more. */
export const USER_ORIGINS: StatementOrigin[] = [
  "editor",
  "grid",
  "designer",
  "routine",
  "admin",
  "schema",
];

export interface RunStatementOptions {
  connectionId: string;
  sql: string;
  database?: string;
  origin: StatementOrigin;
}

/**
 * Run a statement and record it, whatever part of the app is asking.
 *
 * Deliberately not the production gate as well: a caller running a hundred
 * statements from a dump confirms once for the operation, not once per
 * statement, so that decision belongs to the caller. `confirmDestructive`
 * stays a separate call.
 */
export async function runStatement(
  options: RunStatementOptions,
): Promise<QueryResult[]> {
  const { connectionId, sql, database, origin } = options;
  const startTime = Date.now();
  const connection = useConnectionStore
    .getState()
    .activeConnections.find((c) => c.id === connectionId);

  try {
    const results = await api.executeQuery(connectionId, sql, database);
    // Recording is a side effect of running the statement. If it throws, the
    // statement still ran, and reporting it as a failure would tell the caller
    // to roll back something that already succeeded.
    try {
      record({ results, sql, connection, database, origin, startTime });
    } catch (e) {
      console.warn("Could not record query history", e);
    }
    return results;
  } catch (e) {
    // Without a connection the statement never reached a server, so there is
    // no query to remember — the same rule the editor path follows (#328).
    if (connection) {
      const structured = e instanceof CommandError ? e : undefined;
      void useHistoryStore.getState().addEntry({
        id: crypto.randomUUID(),
        sql,
        connectionName: connection.name,
        database: database ?? connection.database ?? null,
        executedAt: new Date().toISOString(),
        executionTimeMs: Date.now() - startTime,
        rowCount: 0,
        status: "error",
        error: structured?.message ?? String(e),
        errorCode: structured?.code ?? null,
        errorSqlState: structured?.sqlState ?? null,
        origin,
      });
    }
    // Recording is a side effect. The caller still has to see the failure.
    throw e;
  }
}

function record(
  { results, sql, connection, database, origin, startTime }: {
    results: QueryResult[];
    sql: string;
    connection?: { name: string; database?: string | null };
    database?: string;
    origin: StatementOrigin;
    startTime: number;
  },
) {
  const recordedAt = new Date().toISOString();
  const elapsed = Date.now() - startTime;
  const history = useHistoryStore.getState();

  // One entry per statement, matching the editor path (#329). A statement that
  // produced no result set still ran, so an empty result list records the
  // statement as sent rather than nothing at all.
  const rows = results.length > 0
    // `rows` is absent on a result that reported only a count, so read it
    // defensively rather than trusting every backend shape.
    ? results.map((r) => ({ sql: r.sql || sql, rowCount: r.rows?.length ?? 0 }))
    : [{ sql, rowCount: 0 }];

  for (const row of rows) {
    void history.addEntry({
      id: crypto.randomUUID(),
      sql: row.sql,
      connectionName: connection?.name ?? "Unknown connection",
      database: database ?? connection?.database ?? null,
      executedAt: recordedAt,
      executionTimeMs: elapsed,
      rowCount: row.rowCount,
      status: "success",
      error: null,
      errorCode: null,
      errorSqlState: null,
      origin,
    });
  }
}
