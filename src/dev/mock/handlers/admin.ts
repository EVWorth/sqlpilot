// The admin panel's server-side view: the process list, global variables,
// KILL, and the platform the app thinks it was installed as.
//
// The process list is held per connection and mutated by KILL, so killing a
// thread and refreshing shows it gone, as on a real server. Thread times count
// up from when the list was first read, so auto-refresh visibly ticks.

import type { PlatformInfo, ProcessInfo, ServerVariable } from "../../../lib/bindings";
import { SERVER_VERSION } from "../dataset";
import { delay, fail, type Handlers } from "../router";
import { liveConnection, state } from "../state";

// ---------------------------------------------------------------- processes

/** SQLPilot's own pool: what `get_own_thread_ids` reports for every connection. */
const OWN_THREAD_IDS = [1041, 1042, 1043];

/** The query the backend itself runs to read the list. */
const PROCESSLIST_SQL = "SELECT CAST(ID AS SIGNED) AS ID, CAST(USER AS CHAR) AS USER, CAST(HOST AS CHAR) AS HOST, "
  + "CAST(DB AS CHAR) AS DB, CAST(COMMAND AS CHAR) AS COMMAND, CAST(TIME AS SIGNED) AS TIME, "
  + "CAST(STATE AS CHAR) AS STATE, CAST(INFO AS CHAR) AS INFO FROM INFORMATION_SCHEMA.PROCESSLIST";

interface MockProcess extends ProcessInfo {
  /** Whether `time` keeps counting. A finished query's session restarts at 0. */
  ticking: boolean;
}

function seedProcesses(user: string): MockProcess[] {
  const p = (
    id: number,
    u: string,
    host: string,
    db: string | null,
    command: string,
    time: number,
    state: string | null,
    info: string | null,
  ): MockProcess => ({ id, user: u, host, db, command, time, state, info, ticking: true });

  return [
    p(5, "event_scheduler", "localhost", null, "Daemon", 1_209_644, "Waiting on empty queue", null),
    p(
      18,
      "repl",
      "10.0.4.21:40112",
      null,
      "Binlog Dump GTID",
      604_812,
      "Source has sent all binlog to replica; waiting for more updates",
      null,
    ),
    // The app's own sessions — one of them is the read producing this list.
    { ...p(1041, user, "10.0.1.7:52814", "shop", "Query", 0, "executing", PROCESSLIST_SQL), ticking: false },
    p(1042, user, "10.0.1.7:52816", "shop", "Sleep", 2, "", null),
    p(1043, user, "10.0.1.7:52818", "shop", "Sleep", 14, "", null),
    p(2210, "app", "10.0.3.15:51234", "shop", "Sleep", 3, "", null),
    p(2211, "app", "10.0.3.15:51236", "shop", "Sleep", 47, "", null),
    p(2214, "app", "10.0.3.16:40990", "shop", "Sleep", 1_212, "", null),
    p(
      2219,
      "app",
      "10.0.3.16:40994",
      "shop",
      "Query",
      1,
      "updating",
      "UPDATE orders SET status = 'shipped' WHERE id = 8812",
    ),
    p(
      2302,
      "analyst",
      "10.0.5.9:60311",
      "analytics",
      "Query",
      340,
      "Sending data",
      "SELECT user_id, COUNT(*) AS events, MAX(occurred_at) AS last_seen\nFROM analytics.events\nWHERE occurred_at >= '2026-09-01'\nGROUP BY user_id\nORDER BY events DESC",
    ),
    p(
      2305,
      "migrator",
      "10.0.3.40:39822",
      "shop",
      "Query",
      112,
      "Waiting for table metadata lock",
      "ALTER TABLE orders ADD COLUMN shipped_at DATETIME NULL AFTER placed_at",
    ),
    p(2306, "analyst", "10.0.5.9:60318", "analytics", "Sleep", 590, "", null),
  ];
}

interface ProcessTable {
  processes: MockProcess[];
  readAt: number;
}

/** Per connection, so a kill on one server does not show up on another. */
const processTables = new Map<string, ProcessTable>();

function profileUser(profileId: string): string {
  return state.profiles.find((p) => p.id === profileId)?.username ?? "root";
}

function processTable(connectionId: unknown): ProcessTable {
  const conn = liveConnection(connectionId);
  let table = processTables.get(conn.id);
  if (!table) {
    table = { processes: seedProcesses(profileUser(conn.profile_id)), readAt: Date.now() };
    processTables.set(conn.id, table);
  }
  // Advance every clock by the time since the last read.
  const now = Date.now();
  const elapsed = Math.floor((now - table.readAt) / 1000);
  if (elapsed > 0) {
    for (const proc of table.processes) if (proc.ticking) proc.time += elapsed;
    table.readAt += elapsed * 1000;
  }
  return table;
}

/** Mirrors the backend's refusals, in the order it checks them. */
function kill(args: Record<string, unknown>, scope: "query" | "connection"): null {
  const table = processTable(args.connectionId);
  const id = Number(args.processId);
  if (OWN_THREAD_IDS.includes(id)) {
    fail(
      `Query error: Process ${id} is one of SQLPilot's own connections to this server. `
        + "Killing it would disconnect the app from the server it is managing.",
    );
  }
  const index = table.processes.findIndex((p) => p.id === id);
  if (index < 0) fail(`Query error: error returned from database: 1094 (HY000): Unknown thread id: ${id}`);

  // The read-only production login has no PROCESS privilege, so it can see
  // other users' threads but not kill them — the backend's 1095 rewrite.
  const conn = liveConnection(args.connectionId);
  const me = profileUser(conn.profile_id);
  const target = table.processes[index];
  if (me === "readonly" && target.user !== me) {
    fail(
      `Query error: Not permitted to kill process ${id}. Killing another user's connection needs `
        + "the PROCESS privilege (or CONNECTION_ADMIN on MySQL 8).",
    );
  }

  if (scope === "connection") {
    table.processes.splice(index, 1);
  } else if (target.command === "Query") {
    // KILL QUERY leaves an idle session behind.
    Object.assign(target, { command: "Sleep", time: 0, state: "", info: null, ticking: true });
  }
  return null;
}

// ---------------------------------------------------------------- variables

type VarRow = [name: string, value: string, description: string, readOnly: boolean];

/**
 * A realistic slice of `SHOW GLOBAL VARIABLES`. Descriptions and read-only
 * flags are only reported for MariaDB, as the backend does: MySQL has no
 * table to read them from.
 */
const VARIABLES: VarRow[] = [
  ["autocommit", "ON", "If set to 1, the default, all queries are committed immediately", false],
  ["auto_increment_increment", "1", "Auto-increment columns are incremented by this", false],
  ["auto_increment_offset", "1", "Offset added to Auto-increment columns", false],
  ["basedir", "/usr/", "Path to installation directory", true],
  [
    "binlog_cache_size",
    "32768",
    "The size of the transactional cache for updates to transactional engines for the binary log",
    false,
  ],
  ["binlog_format", "ROW", "The format used when writing the binary log", false],
  [
    "binlog_row_image",
    "FULL",
    "Controls whether rows should be logged in 'FULL', 'NOBLOB' or 'MINIMAL' formats",
    false,
  ],
  ["character_set_client", "utf8mb4", "The character set for statements that arrive from the client", false],
  [
    "character_set_connection",
    "utf8mb4",
    "The character set used for literals that do not have a character set introducer",
    false,
  ],
  ["character_set_database", "utf8mb4", "The character set used by the default database", false],
  ["character_set_results", "utf8mb4", "The character set used for returning query results to the client", false],
  ["character_set_server", "utf8mb4", "The default character set", false],
  ["character_set_system", "utf8mb3", "The character set used by the server for storing identifiers", true],
  ["collation_connection", "utf8mb4_0900_ai_ci", "The collation of the connection character set", false],
  ["collation_database", "utf8mb4_0900_ai_ci", "The collation of the database character set", false],
  ["collation_server", "utf8mb4_0900_ai_ci", "The server default collation", false],
  [
    "connect_timeout",
    "10",
    "The number of seconds the server waits for a connect packet before responding with 'Bad handshake'",
    false,
  ],
  ["datadir", "/var/lib/mysql/", "Path to the database root directory", true],
  ["default_storage_engine", "InnoDB", "The default storage engine for new tables", false],
  ["event_scheduler", "ON", "Enable the event scheduler", false],
  [
    "explicit_defaults_for_timestamp",
    "ON",
    "This option causes CREATE TABLE to create all TIMESTAMP columns as NULL with DEFAULT NULL attribute",
    false,
  ],
  ["general_log", "OFF", "Log connections and queries to a table or log file", false],
  ["gtid_mode", "ON", "Whether GTID-based logging is used", false],
  ["hostname", "db-primary-01", "Server host name", true],
  ["innodb_buffer_pool_instances", "8", "Number of buffer pool instances", true],
  [
    "innodb_buffer_pool_size",
    "8589934592",
    "The size of the memory buffer InnoDB uses to cache data and indexes of its tables",
    false,
  ],
  ["innodb_file_per_table", "ON", "Stores each InnoDB table to an .ibd file in the database dir", false],
  ["innodb_flush_log_at_trx_commit", "1", "Controls the durability/speed trade-off for commits", false],
  ["innodb_flush_method", "O_DIRECT", "With which method to flush data", true],
  ["innodb_io_capacity", "2000", "Number of IOPs the server can do. Tunes the background IO rate", false],
  [
    "innodb_lock_wait_timeout",
    "50",
    "Timeout in seconds an InnoDB transaction may wait for a lock before being rolled back",
    false,
  ],
  ["innodb_log_file_size", "1073741824", "Redo log size", false],
  ["innodb_page_size", "16384", "Page size to use for all InnoDB tablespaces", true],
  ["innodb_read_io_threads", "4", "Number of background read I/O threads in InnoDB", true],
  ["innodb_write_io_threads", "4", "Number of background write I/O threads in InnoDB", true],
  [
    "interactive_timeout",
    "28800",
    "The number of seconds the server waits for activity on an interactive connection before closing it",
    false,
  ],
  ["join_buffer_size", "262144", "The size of the buffer that is used for full joins", false],
  ["lock_wait_timeout", "31536000", "Timeout in seconds to wait for a lock before returning an error", false],
  ["log_bin", "ON", "Whether the binary log is enabled", true],
  [
    "long_query_time",
    "2.000000",
    "Log all queries that have taken more than long_query_time seconds to execute to the slow query log file",
    false,
  ],
  [
    "lower_case_table_names",
    "0",
    "If set to 1 table names are stored in lowercase on disk and table names will be case-insensitive",
    true,
  ],
  ["max_allowed_packet", "67108864", "Max packet length to send to or receive from the server", false],
  ["max_connections", "500", "The number of simultaneous clients allowed", false],
  ["max_execution_time", "0", "Kill SELECT statements that take longer than this many milliseconds", false],
  ["max_heap_table_size", "16777216", "Don't allow creation of heap tables bigger than this", false],
  ["max_user_connections", "0", "The maximum number of active connections for a single user (0 = no limit)", false],
  [
    "net_read_timeout",
    "30",
    "Number of seconds to wait for more data from a connection before aborting the read",
    false,
  ],
  [
    "net_write_timeout",
    "60",
    "Number of seconds to wait for a block to be written to a connection before aborting the write",
    false,
  ],
  ["open_files_limit", "65535", "If this is not 0, then mysqld will use this value to reserve file descriptors", true],
  ["performance_schema", "ON", "Enable the performance schema", true],
  [
    "port",
    "3306",
    "Port number to use for connection or 0 to default to, my.cnf, $MYSQL_TCP_PORT, /etc/services, built-in default (3306)",
    true,
  ],
  ["read_only", "OFF", "Do not allow changes to non-temporary tables, except by users with the SUPER privilege", false],
  ["server_id", "1", "Uniquely identifies the server instance in the community of replication partners", false],
  ["slow_query_log", "ON", "Log slow queries to a table or log file", false],
  ["socket", "/var/run/mysqld/mysqld.sock", "Socket file to use for connection", true],
  ["sort_buffer_size", "262144", "Each thread that needs to do a sort allocates a buffer of this size", false],
  [
    "sql_mode",
    "ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION",
    "Sets the sql mode",
    false,
  ],
  ["sync_binlog", "1", "Synchronously flush binary log to disk after every #th event", false],
  ["system_time_zone", "UTC", "The server system time zone", true],
  ["table_open_cache", "4000", "The number of cached open tables", false],
  ["thread_cache_size", "64", "How many threads we should keep in a cache for reuse", false],
  [
    "time_zone",
    "+00:00",
    "The current time zone, used to initialize the time zone for a client when it connects",
    false,
  ],
  ["tmp_table_size", "16777216", "Max size for data for an internal temporary on-disk MyISAM or Aria table", false],
  ["transaction_isolation", "REPEATABLE-READ", "Default transaction isolation level", false],
  ["version", "", "Server version number", true],
  [
    "version_comment",
    "MySQL Community Server - GPL",
    "Value of the COMPILATION_COMMENT option specified by CMake when building MariaDB",
    true,
  ],
  [
    "wait_timeout",
    "28800",
    "The number of seconds the server waits for activity on a connection before closing it",
    false,
  ],
];

/** Where MariaDB's defaults differ visibly from MySQL's. */
const MARIADB_VALUES: Record<string, string> = {
  character_set_system: "utf8mb3",
  collation_connection: "utf8mb4_uca1400_ai_ci",
  collation_database: "utf8mb4_uca1400_ai_ci",
  collation_server: "utf8mb4_uca1400_ai_ci",
  gtid_mode: "",
  sql_mode: "STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION",
  transaction_isolation: "REPEATABLE-READ",
  version_comment: "MariaDB Server",
  port: "3307",
};

function serverVariables(connectionId: unknown): ServerVariable[] {
  const conn = liveConnection(connectionId);
  const version = conn.server_version || SERVER_VERSION[conn.profile_id] || "8.0.39";
  const mariadb = /mariadb/i.test(version);
  return VARIABLES
    // gtid_mode is MySQL's; MariaDB has its own gtid_* family instead.
    .filter(([name]) => !(mariadb && name === "gtid_mode"))
    .map(([name, value, description, readOnly]) => ({
      name,
      value: name === "version" ? version : mariadb ? (MARIADB_VALUES[name] ?? value) : value,
      description: mariadb ? description : null,
      readOnly: mariadb ? readOnly : null,
    }));
}

// ---------------------------------------------------------------- handlers

export const adminHandlers: Handlers = {
  get_process_list: async ({ connectionId }) => {
    await delay(180);
    return processTable(connectionId).processes.map(
      (p): ProcessInfo => ({
        id: p.id,
        user: p.user,
        host: p.host,
        db: p.db,
        command: p.command,
        time: p.time,
        state: p.state,
        info: p.info,
      }),
    );
  },
  get_own_thread_ids: ({ connectionId }) => {
    liveConnection(connectionId);
    return [...OWN_THREAD_IDS];
  },
  get_server_variables: async ({ connectionId }) => {
    await delay(220);
    return serverVariables(connectionId);
  },
  kill_process: async (args) => {
    await delay(150);
    return kill(args, "connection");
  },
  kill_query: async (args) => {
    await delay(150);
    return kill(args, "query");
  },
  // An AppImage: the one Linux format the updater handles itself, so the
  // update chip behaves normally in screenshots.
  get_platform_info: (): PlatformInfo => ({ package_format: "app_image", arch: "x86_64" }),
  // The browser has no native menu bar; the in-app one renders the same list.
  set_native_menu: () => null,
};
