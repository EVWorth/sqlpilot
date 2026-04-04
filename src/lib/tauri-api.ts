import { invoke } from "@tauri-apps/api/core";
import type {
  ConnectionProfile,
  ConnectionInfo,
  TestConnectionResult,
  QueryResult,
  DatabaseInfo,
  TableInfo,
  ColumnInfo,
  IndexInfo,
  ProcessInfo,
  ServerVariable,
} from "../types";

// In dev mode without Tauri, provide mock fallbacks
const isTauri = "__TAURI_INTERNALS__" in window;

async function tauriInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri) {
    console.warn(`Tauri not available, mock call: ${cmd}`, args);
    throw new Error(`Tauri not available for command: ${cmd}`);
  }
  return invoke<T>(cmd, args);
}

// Connection API
export const api = {
  // Connections
  saveConnectionProfile: (profile: ConnectionProfile) =>
    tauriInvoke<string>("save_connection_profile", { profile }),

  listConnectionProfiles: () =>
    tauriInvoke<ConnectionProfile[]>("list_connection_profiles"),

  deleteConnectionProfile: (profileId: string) =>
    tauriInvoke<void>("delete_connection_profile", { profileId }),

  testConnection: (profile: ConnectionProfile) =>
    tauriInvoke<TestConnectionResult>("test_connection", { profile }),

  connect: (profileId: string) =>
    tauriInvoke<ConnectionInfo>("connect", { profileId }),

  disconnect: (connectionId: string) =>
    tauriInvoke<void>("disconnect", { connectionId }),

  listConnections: () =>
    tauriInvoke<ConnectionInfo[]>("list_connections"),

  // Queries
  executeQuery: (connectionId: string, sql: string) =>
    tauriInvoke<QueryResult[]>("execute_query", { connectionId, sql }),

  // Schema
  getDatabases: (connectionId: string) =>
    tauriInvoke<DatabaseInfo[]>("get_databases", { connectionId }),

  getTables: (connectionId: string, database: string) =>
    tauriInvoke<TableInfo[]>("get_tables", { connectionId, database }),

  getColumns: (connectionId: string, database: string, table: string) =>
    tauriInvoke<ColumnInfo[]>("get_columns", {
      connectionId,
      database,
      table,
    }),

  getIndexes: (connectionId: string, database: string, table: string) =>
    tauriInvoke<IndexInfo[]>("get_indexes", {
      connectionId,
      database,
      table,
    }),

  getTableDdl: (connectionId: string, database: string, table: string) =>
    tauriInvoke<string>("get_table_ddl", { connectionId, database, table }),

  // Export
  exportResults: (result: QueryResult, format: string, tableName?: string) =>
    tauriInvoke<string>("export_results", { result, format, tableName }),

  // Admin
  getProcessList: (connectionId: string) =>
    tauriInvoke<ProcessInfo[]>("get_process_list", { connectionId }),

  getServerVariables: (connectionId: string) =>
    tauriInvoke<ServerVariable[]>("get_server_variables", { connectionId }),

  killProcess: (connectionId: string, processId: number) =>
    tauriInvoke<void>("kill_process", { connectionId, processId }),
};
