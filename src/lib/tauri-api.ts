import { getVersion } from "@tauri-apps/api/app";
import type { AiConfig, AiMode, ConnectionProfileInput, QueryResult } from "../types";
import { commands } from "./bindings";

/**
 * Policy layer over the generated bindings in `./bindings.ts`.
 *
 * The command names, argument types and return types all come from Rust via
 * tauri-specta, so nothing here restates the wire contract. What this module
 * still owns is behaviour the generated code cannot provide:
 *
 * - the non-Tauri guard, so `make dev-web` fails with a clear message rather
 *   than a raw Tauri internals error
 * - the error convention: generated commands resolve to
 *   `{ status: "ok" | "error" }`, while every caller here expects a rejected
 *   promise, so `unwrap` converts one into the other in a single place
 * - a seam for anything cross-cutting (logging, retries) later
 */

// In dev mode without Tauri, provide mock fallbacks
const isTauri = "__TAURI_INTERNALS__" in window;

type CommandResult<T, E> = { status: "ok"; data: T } | { status: "error"; error: E };

/**
 * Turn a generated command's result union into the throwing promise the rest
 * of the app is written against.
 */
async function unwrap<T, E>(
  name: string,
  run: () => Promise<CommandResult<T, E>>,
): Promise<T> {
  if (!isTauri) {
    console.warn(`Tauri not available, mock call: ${name}`);
    throw new Error(`Tauri not available for command: ${name}`);
  }
  const result = await run();
  if (result.status === "error") {
    throw new Error(typeof result.error === "string" ? result.error : String(result.error));
  }
  return result.data;
}

// Optional arguments are `T | undefined` in this API but `T | null` in the
// generated signatures, since Rust's Option round-trips as null.
const orNull = <T>(v: T | undefined): T | null => v ?? null;

export const api = {
  // Connections
  saveConnectionProfile: (profile: ConnectionProfileInput) =>
    unwrap("save_connection_profile", () => commands.saveConnectionProfile(profile)),

  listConnectionProfiles: () => unwrap("list_connection_profiles", () => commands.listConnectionProfiles()),

  deleteConnectionProfile: (profileId: string) =>
    unwrap("delete_connection_profile", () => commands.deleteConnectionProfile(profileId)),

  testConnection: (profile: ConnectionProfileInput) =>
    unwrap("test_connection", () => commands.testConnection(profile)),

  connect: (profileId: string) => unwrap("connect", () => commands.connect(profileId)),

  disconnect: (connectionId: string) => unwrap("disconnect", () => commands.disconnect(connectionId)),

  listConnections: () => unwrap("list_connections", () => commands.listConnections()),

  // Queries
  executeQuery: (connectionId: string, sql: string, database?: string, limit?: number) =>
    unwrap("execute_query", () => commands.executeQuery(connectionId, sql, orNull(database), orNull(limit))),

  // EXPLAIN goes through its own command rather than executeQuery: ANALYZE runs
  // the statement it measures, so the decision to downgrade a write to a plain
  // EXPLAIN lives behind the IPC boundary.
  explainQuery: (connectionId: string, sql: string, analyze: boolean, database?: string) =>
    unwrap("explain_query", () => commands.explainQuery(connectionId, sql, orNull(database), analyze)),

  cancelQuery: (connectionId: string) => unwrap("cancel_query", () => commands.cancelQuery(connectionId)),

  // Schema
  getDatabases: (connectionId: string) => unwrap("get_databases", () => commands.getDatabases(connectionId)),

  getTables: (connectionId: string, database: string) =>
    unwrap("get_tables", () => commands.getTables(connectionId, database)),

  getColumns: (connectionId: string, database: string, table: string) =>
    unwrap("get_columns", () => commands.getColumns(connectionId, database, table)),

  getIndexes: (connectionId: string, database: string, table: string) =>
    unwrap("get_indexes", () => commands.getIndexes(connectionId, database, table)),

  getTableDdl: (connectionId: string, database: string, table: string) =>
    unwrap("get_table_ddl", () => commands.getTableDdl(connectionId, database, table)),

  getViews: (connectionId: string, database: string) =>
    unwrap("get_views", () => commands.getViews(connectionId, database)),

  getRoutines: (connectionId: string, database: string) =>
    unwrap("get_routines", () => commands.getRoutines(connectionId, database)),

  getTriggers: (connectionId: string, database: string) =>
    unwrap("get_triggers", () => commands.getTriggers(connectionId, database)),

  getViewDdl: (connectionId: string, database: string, viewName: string) =>
    unwrap("get_view_ddl", () => commands.getViewDdl(connectionId, database, viewName)),

  getRoutineDdl: (connectionId: string, database: string, routineName: string, routineType: string) =>
    unwrap("get_routine_ddl", () => commands.getRoutineDdl(connectionId, database, routineName, routineType)),

  getTriggerDdl: (connectionId: string, database: string, triggerName: string) =>
    unwrap("get_trigger_ddl", () => commands.getTriggerDdl(connectionId, database, triggerName)),

  // Export
  // The command takes the Deserialize phase, where total_rows_available is
  // required; skip_serializing_if means it can be absent on the way back, so
  // fill it in rather than widening the Rust type.
  exportResults: (result: QueryResult, format: string, tableName?: string) =>
    unwrap("export_results", () =>
      commands.exportResults(
        { ...result, total_rows_available: result.total_rows_available ?? null },
        format,
        orNull(tableName),
      )),

  // Admin
  getProcessList: (connectionId: string) => unwrap("get_process_list", () => commands.getProcessList(connectionId)),

  getServerVariables: (connectionId: string) =>
    unwrap("get_server_variables", () => commands.getServerVariables(connectionId)),

  killProcess: (connectionId: string, processId: number) =>
    unwrap("kill_process", () => commands.killProcess(connectionId, processId)),

  // File import
  readFileContents: (path: string) => unwrap("read_file_contents", () => commands.readFileContents(path)),

  pickFile: (title: string, filters: [string, string[]][]) =>
    unwrap("pick_file", () => commands.pickFile(title, filters)),

  writeFileContents: (path: string, contents: string) =>
    unwrap("write_file_contents", () => commands.writeFileContents(path, contents)),

  pickSaveFile: (title: string, defaultName: string, filters: [string, string[]][]) =>
    unwrap("pick_save_file", () => commands.pickSaveFile(title, defaultName, filters)),

  // AI
  aiChat: (message: string, conversationId: string, mode: AiMode, connectionId?: string, database?: string) =>
    unwrap(
      "ai_chat",
      () => commands.aiChat(message, conversationId, mode, orNull(connectionId), orNull(database)),
    ),

  aiGetStatus: () => unwrap("ai_get_status", () => commands.aiGetStatus()),

  aiSetConfig: (config: AiConfig) => unwrap("ai_set_config", () => commands.aiSetConfig(config)),

  aiCancel: (conversationId: string) => unwrap("ai_cancel", () => commands.aiCancel(conversationId)),

  aiApprovePermission: (conversationId: string, requestId: string, approved: boolean) =>
    unwrap("ai_approve_permission", () => commands.aiApprovePermission(conversationId, requestId, approved)),

  // App metadata — not a Tauri command, so it stays hand-written
  getAppVersion: (): Promise<string> =>
    isTauri
      ? getVersion()
      : Promise.resolve(import.meta.env.VITE_APP_VERSION ?? ""),

  // SQLite
  sqliteOpen: (path: string) => unwrap("sqlite_open", () => commands.sqliteOpen(path)),

  sqliteClose: (connectionId: string) => unwrap("sqlite_close", () => commands.sqliteClose(connectionId)),

  sqliteList: () => unwrap("sqlite_list", () => commands.sqliteList()),

  sqliteExecute: (connectionId: string, sql: string) =>
    unwrap("sqlite_execute", () => commands.sqliteExecute(connectionId, sql)),

  sqliteGetTables: (connectionId: string) => unwrap("sqlite_get_tables", () => commands.sqliteGetTables(connectionId)),

  sqliteGetColumns: (connectionId: string, table: string) =>
    unwrap("sqlite_get_columns", () => commands.sqliteGetColumns(connectionId, table)),

  sqliteGetIndexes: (connectionId: string, table: string) =>
    unwrap("sqlite_get_indexes", () => commands.sqliteGetIndexes(connectionId, table)),

  sqliteGetTableDdl: (connectionId: string, table: string) =>
    unwrap("sqlite_get_table_ddl", () => commands.sqliteGetTableDdl(connectionId, table)),

  // Platform detection
  isRpmOstree: () => unwrap("is_rpm_ostree", () => commands.isRpmOstree()),
};
