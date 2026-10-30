import type {
  ColumnInfo,
  DatabaseInfo,
  EventInfo,
  ForeignKeyInfo,
  IndexInfo,
  PartitionInfo,
  QueryResult,
  RoutineInfo,
  TableInfo,
  TriggerInfo,
  ViewInfo,
} from "../types";
import { api } from "./tauri-api";

/**
 * What kind of server is behind a connection id, and how to talk to it.
 *
 * The shared pane — sidebar, editor, results grid — should not know which
 * backend it is looking at. It asks the data source for databases, tables,
 * columns and results, and gets the same shapes back whatever answered.
 *
 * SQLite was the first backend to need this: a whole crate, eight commands
 * and a set of API wrappers existed with no UI calling any of them (#461).
 * Rather than branching on "is this SQLite" wherever a query is run, each
 * backend implements this interface once, and a third one slots in beside
 * them without touching the pane.
 */

export type DataSourceKind = "mysql" | "sqlite";

export interface DataSource {
  readonly kind: DataSourceKind;
  /** True when the backend groups tables under databases the user can switch. */
  readonly hasDatabases: boolean;
  listDatabases(connectionId: string): Promise<DatabaseInfo[]>;
  listTables(connectionId: string, database: string): Promise<TableInfo[]>;
  listViews(connectionId: string, database: string): Promise<ViewInfo[]>;
  listRoutines(connectionId: string, database: string): Promise<RoutineInfo[]>;
  listTriggers(connectionId: string, database: string): Promise<TriggerInfo[]>;
  /** Scheduled events (FR-4.1.1, #291). SQLite has no scheduler. */
  listEvents(connectionId: string, database: string): Promise<EventInfo[]>;
  getColumns(connectionId: string, database: string, table: string): Promise<ColumnInfo[]>;
  getIndexes(connectionId: string, database: string, table: string): Promise<IndexInfo[]>;
  getForeignKeys(connectionId: string, database: string, table: string): Promise<ForeignKeyInfo[]>;
  getPartitions(connectionId: string, database: string, table: string): Promise<PartitionInfo[]>;
  getTableDdl(connectionId: string, database: string, table: string): Promise<string>;
  getViewDdl(connectionId: string, database: string, view: string): Promise<string>;
  execute(
    connectionId: string,
    sql: string,
    database?: string,
    limit?: number,
    /** Rows to skip before the first one kept, for paging (#391). */
    offset?: number,
    /**
     * The editor tab running this, for a backend whose tabs keep their own
     * server session (#731). A backend without sessions ignores it.
     */
    session?: string,
  ): Promise<QueryResult[]>;
}

const mysql: DataSource = {
  kind: "mysql",
  hasDatabases: true,
  listDatabases: (c) => api.getDatabases(c),
  listTables: (c, d) => api.getTables(c, d),
  listViews: (c, d) => api.getViews(c, d),
  listRoutines: (c, d) => api.getRoutines(c, d),
  listTriggers: (c, d) => api.getTriggers(c, d),
  listEvents: (c, d) => api.getEvents(c, d),
  getColumns: (c, d, t) => api.getColumns(c, d, t),
  getIndexes: (c, d, t) => api.getIndexes(c, d, t),
  getForeignKeys: (c, d, t) => api.getForeignKeys(c, d, t),
  getPartitions: (c, d, t) => api.getPartitions(c, d, t),
  getTableDdl: (c, d, t) => api.getTableDdl(c, d, t),
  getViewDdl: (c, d, v) => api.getViewDdl(c, d, v),
  execute: (c, sql, d, limit, offset, session) => api.executeQuery(c, sql, d, limit, offset, session),
};

/**
 * A SQLite file has no databases to switch between, so it reports a single
 * one named after the file. That keeps the tree's shape — connection, then
 * database, then tables — identical for both backends, which is cheaper and
 * less surprising than giving SQLite its own tree.
 */
export const SQLITE_SCHEMA_NAME = "main";

/**
 * `sqlite_master.type`, in the words MySQL's information_schema uses.
 *
 * SQLite stores "table" and "view" in lower case, and the tree tells a view
 * from a table by `table_type === "VIEW"`, so a SQLite view was listed and
 * counted under Tables and the Views folder stayed empty (#825).
 */
export function sqliteTableType(type: string): string {
  const lower = type.toLowerCase();
  if (lower === "view") return "VIEW";
  if (lower === "table") return "BASE TABLE";
  return type.toUpperCase();
}

const sqlite: DataSource = {
  kind: "sqlite",
  hasDatabases: false,
  listDatabases: async () => [
    {
      name: SQLITE_SCHEMA_NAME,
      default_charset: "UTF-8",
      default_collation: "BINARY",
      // A SQLite file has one schema and it is the user's. Nothing to hide.
      is_system: false,
    },
  ],
  listTables: async (c) =>
    (await api.sqliteGetTables(c)).map((t) => ({
      name: t.name,
      table_type: sqliteTableType(t.table_type),
      engine: null,
      row_count: t.row_count,
      data_size: null,
      comment: "",
    })),
  // Views come back with the tables from `sqlite_master`; this picks them
  // out. Without INSTEAD OF triggers a SQLite view cannot be written to.
  listViews: async (c) =>
    (await api.sqliteGetTables(c))
      .filter((t) => sqliteTableType(t.table_type) === "VIEW")
      .map((t) => ({ name: t.name, is_updatable: false })),
  // SQLite has no stored routines, and its triggers are not exposed yet.
  // Empty rather than absent, so the tree renders the same folders and simply
  // shows nothing in them.
  listRoutines: async () => [],
  listTriggers: async () => [],
  // SQLite has no event scheduler, so the folder stays empty rather than
  // absent — the tree renders the same shape for both backends.
  listEvents: async () => [],
  getColumns: async (c, _d, t) =>
    (await api.sqliteGetColumns(c, t)).map((col) => ({
      name: col.name,
      data_type: col.data_type,
      column_type: col.data_type,
      nullable: col.nullable,
      default_value: col.default_value,
      is_primary_key: col.is_primary_key,
      extra: "",
      comment: "",
      charset: null,
      collation: null,
    })),
  getIndexes: async (c, _d, t) =>
    (await api.sqliteGetIndexes(c, t)).map((i) => ({
      name: i.name,
      columns: i.columns,
      is_unique: i.is_unique,
      index_type: "BTREE",
    })),
  // From `PRAGMA foreign_key_list`, already in MySQL's shape. SQLite keeps no
  // constraint names, so each key's name is made up by the backend (#924).
  getForeignKeys: (c, _d, t) => api.sqliteGetForeignKeys(c, t),
  // SQLite has no partitioning.
  getPartitions: async () => [],
  getTableDdl: (c, _d, t) => api.sqliteGetTableDdl(c, t),
  // `sqlite_get_table_ddl` reads only `type='table'` rows, but the listing
  // already carries every object's `CREATE` statement, views included.
  getViewDdl: async (c, _d, v) => {
    const view = (await api.sqliteGetTables(c)).find(
      (t) => t.name === v && sqliteTableType(t.table_type) === "VIEW",
    );
    if (!view?.sql) throw new Error(`No definition found for view ${v}`);
    return view.sql;
  },
  // Paging is not wired through the SQLite backend yet, so an offset is
  // ignored rather than silently returning the first page again. The grid
  // only offers paging where the source reports a truncated result, which
  // SQLite does not.
  execute: async (c, sql) =>
    (await api.sqliteExecute(c, sql)).map((r) => ({
      query_id: r.query_id,
      statement_index: r.statement_index,
      // The statement this result came from, as the backend split it (#928).
      sql: r.sql,
      columns: r.columns.map((col) => ({
        name: col.name,
        data_type: col.data_type,
        column_type: col.data_type,
        nullable: col.nullable,
        is_primary_key: col.is_primary_key,
      })),
      rows: r.rows,
      rows_affected: r.rows_affected,
      execution_time_ms: r.execution_time_ms,
      warnings: r.warnings,
      rows_truncated: r.rows_truncated,
    })) as QueryResult[],
};

const SOURCES: Record<DataSourceKind, DataSource> = { mysql, sqlite };

/**
 * Which backend owns a connection id.
 *
 * A plain map rather than a lookup into either store, so neither store has to
 * know about the other and a new backend registers itself the same way.
 */
const kinds = new Map<string, DataSourceKind>();

export function registerConnectionKind(connectionId: string, kind: DataSourceKind): void {
  kinds.set(connectionId, kind);
}

export function forgetConnectionKind(connectionId: string): void {
  kinds.delete(connectionId);
}

export function connectionKind(connectionId: string): DataSourceKind {
  return kinds.get(connectionId) ?? "mysql";
}

/** The data source for a connection. Unknown ids are MySQL, as they were. */
export function dataSourceFor(connectionId: string): DataSource {
  return SOURCES[connectionKind(connectionId)];
}
