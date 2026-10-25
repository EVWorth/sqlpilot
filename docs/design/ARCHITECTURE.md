# SQLPilot — Software Architecture

How the app is put together today: the processes, the crates, the IPC
surface, and the reasons behind the shapes that are not obvious. Technology
choices and their history are in [TECH_DECISIONS.md](TECH_DECISIONS.md); the
agent surface is in [AI_INTEGRATION.md](AI_INTEGRATION.md).

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Technology Stack](#2-technology-stack)
3. [Component Architecture](#3-component-architecture)
4. [Data Flow](#4-data-flow)
5. [IPC Interface](#5-ipc-interface)
6. [Security Architecture](#6-security-architecture)
7. [Error Handling](#7-error-handling)
8. [Performance](#8-performance)
9. [Local Storage](#9-local-storage)

---

## 1. Architecture Overview

SQLPilot is a Tauri 2 desktop app. A Rust backend handles every database
operation, file I/O and OS integration; a React/TypeScript frontend renders
the UI in the OS webview. The two halves talk only through Tauri IPC: typed
commands (request/response) and events (backend to frontend). A third
participant is optional: the user's own agent harness, which reaches the
backend over MCP on loopback, never through the webview.

### System Diagram

```
┌─────────────────────────────────────────────────────┐
│                   Frontend (React)                   │
│  SQL editor (Monaco) · results grid (TanStack)       │
│  schema tree · table designer · backup/restore       │
│  admin panel · agent panel · settings                │
│  Zustand stores → api.* (tauri-api.ts) → bindings.ts │
├─────────────────────────────────────────────────────┤
│               Tauri IPC (commands + events)          │
├─────────────────────────────────────────────────────┤
│                   Backend (Rust)                      │
│  src-tauri/src      commands, MCP wiring, menu       │
│  mas-core           connections, queries, schema,    │
│                     backup/restore, history          │
│  mas-admin          processes, server variables      │
│  mas-export         result formatting                │
│  mas-sqlite         user SQLite files                │
│  mas-mcp            MCP tools, policy, endpoint ◄────┼── user's harness
│  mas-agent          spawns and talks to harnesses    │   (loopback HTTP)
├─────────────────────────────────────────────────────┤
│          MySQL / MariaDB servers (sqlx, optional TLS)│
└─────────────────────────────────────────────────────┘
```

### Process Model

One OS process. The Tauri main thread runs the window and IPC; command
handlers are async and run on the Tokio runtime alongside the health checkers,
backups and restores, and the MCP endpoint. An in-app agent session is a
child process (the harness CLI) that SQLPilot spawns and talks to over stdio.

### Key Principles

| Principle                  | Description                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Separation of concerns** | Database I/O and OS integration live in Rust. The frontend holds UI state and composes SQL for the user to see.       |
| **Async everywhere**       | Backend operations are non-blocking on Tokio; the UI thread is never blocked on a server.                             |
| **Bounded by default**     | Query results are capped at a row limit and paged; backup, restore and SQL import stream through the backend.         |
| **Offline first**          | Nothing needs a network beyond the database. The app never calls a model; an agent session is the user's own harness. |
| **Credentials stay put**   | Passwords go to the OS credential store and are never sent back to the frontend.                                      |

---

## 2. Technology Stack

Exact versions are in [`package.json`](../../package.json) and
[`src-tauri/Cargo.toml`](../../src-tauri/Cargo.toml); the reasons for the
major picks are ADRs in [TECH_DECISIONS.md](TECH_DECISIONS.md).

**Frontend:** React 19, TypeScript, Vite 8, Tailwind 4, Zustand 5, Monaco
(via `@monaco-editor/react`), TanStack Table and TanStack Virtual,
react-resizable-panels, sql-formatter, lucide-react, and the Tauri updater,
process and shell plugins.

Monaco is imported as `editor.all` plus the SQL and MySQL language
contributions (`src/main.tsx`), not the `monaco-editor` barrel: the barrel
carries the TypeScript, CSS, HTML and JSON language services, whose workers
are 10.8 MB of a build that never edits those languages. Formatting is
frontend-only: a round trip to Rust to reformat the text being typed would buy
nothing.

**Backend:** Rust, Tauri 2, Tokio, sqlx (MySQL, rustls), rusqlite (bundled
SQLite), `keyring-core` with a native store per platform, rmcp and axum for
the MCP endpoint, tauri-specta for generated TypeScript bindings, tracing.

**Tooling:** npm, `just`, mise for pinned toolchains, ESLint, Prettier and
dprint, Clippy and rustfmt, Vitest (jsdom and browser mode), lefthook, GitHub
Actions. See [TESTING_STRATEGY.md](TESTING_STRATEGY.md) and
[`../CI.md`](../CI.md).

---

## 3. Component Architecture

### 3.1 Connection Manager

`mas_core::connection` owns profiles, live connections and their health.
Types are in
[`src-tauri/crates/mas-core/src/models/connection.rs`](../../src-tauri/crates/mas-core/src/models/connection.rs);
the manager is
[`connection/manager.rs`](../../src-tauri/crates/mas-core/src/connection/manager.rs).

| Component             | Responsibility                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ConnectionStore**   | rusqlite persistence of profiles in `connections.db`; passwords in the OS credential store (§6.1)                                                     |
| **ConnectionManager** | `DashMap` of live connections by id. Each connection has several lanes (below)                                                                        |
| **Health checker**    | One task per connection: `SELECT 1` every 15s, backing off while down. Reports through `connection-health-event`; ends when the connection is dropped |
| **SSH tunnel**        | Not implemented. A profile configured for a tunnel is refused rather than connected directly (#273)                                                   |

**Lanes.** A connection is not one pool. The interactive lane (a small fixed
pool, `INTERACTIVE_LANE_MAX`) serves the schema tree, designer and other short
work. Each editor tab gets its own server session, opened on its first
statement, so `SET @var`, temporary tables and open transactions persist
between runs (#731). Agent sessions get their own small pools that close when
idle, and each backup or restore opens a connection of its own for the length
of the job. The profile's `pool_min`/`pool_max` are stored but no longer read.

**Health and backoff.** A healthy connection is pinged every 15 seconds. From
the first failed ping the gaps are 1s, 2s, 4s, 8s, 16s, then 30s capped, until
one succeeds.

```
healthy       ──► SELECT 1 every 15s, reported only when the state changes
first failure ──► marked lost, reported on every attempt so the UI can count them
retries       ──► 1s, 2s, 4s, 8s, 16s, 30s, 30s …
recovery      ──► marked healthy, reported once
```

There is no separate reconnect step and no attempt limit. Nothing is torn down
when a connection is lost: sqlx opens a fresh pooled connection when one is
next asked for. No jitter: it exists to stop a thousand clients retrying in
lockstep, and a desktop client has no herd to disperse.

### 3.2 Query Executor

[`mas_core::query`](../../src-tauri/crates/mas-core/src/query/) runs the
user's SQL.

| Feature                | Implementation                                                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Text protocol**      | `sqlx::raw_sql(...).fetch_many()` (COM_QUERY), which accepts `USE`, `SHOW CREATE` and multi-statement scripts that prepared statements reject                                    |
| **Bounded results**    | Rows are read from the stream and kept up to the row limit (default 1000); the rest is drained. Paging re-runs with an offset. `rows_truncated` says when the cap was hit (§4.2) |
| **Multi-statement**    | `split_statements` respects quotes and comments; each result carries its `statement_index`, and a failure says which statement failed                                            |
| **Cancellation**       | `cancel_query` sends `KILL QUERY` for the session's thread from a separate connection; the session survives                                                                      |
| **Query timeout**      | Per-profile `query_timeout_secs`                                                                                                                                                 |
| **Read-only profiles** | Enforced in the backend (`CoreError::ReadOnly`), not just in the UI                                                                                                              |
| **EXPLAIN**            | `explain_query`: tabular, JSON or tree format, optional ANALYZE; unsupported combinations fall back and say so                                                                   |
| **Grid edits**         | `apply_grid_edits` runs generated statements on the tab's own session and reports its transaction state                                                                          |
| **Staged writes**      | `query::staged` runs an agent's write in a held, uncommitted transaction until the user decides (§5.12)                                                                          |

The result shape is `QueryResult` in
[`models/query.rs`](../../src-tauri/crates/mas-core/src/models/query.rs).

### 3.3 Schema Inspector

[`mas_core::schema::inspector`](../../src-tauri/crates/mas-core/src/schema/inspector.rs)
reads `INFORMATION_SCHEMA` (`SCHEMATA`, `TABLES`, `VIEWS`, `COLUMNS`,
`STATISTICS`, `KEY_COLUMN_USAGE`, `REFERENTIAL_CONSTRAINTS`, `ROUTINES`,
`TRIGGERS`, `EVENTS`, `PARTITIONS`) with bound parameters, and `SHOW CREATE`
for DDL. Identifiers are quoted with `schema::ident::quote_ident`.

**The cache is in the frontend,** in `src/stores/schemaStore.ts`, keyed by
connection: databases, then per database the tables, views, routines,
triggers and events, and columns per table. There is no backend cache and no
TTL. The app invalidates what it changed when it changes it (one folder, one
database, or everything), and the user has Refresh for changes made
elsewhere. A generation counter per connection, held outside the store, lets a
fetch drop its result if a refresh or disconnect happened while it was in
flight (#288).

Why no TTL: a schema changes when someone runs DDL, not on a timer. A TTL
re-reads schemas nobody touched and still shows a stale tree after a change
the app itself made. Why no `schema_changed` event: DDL is issued from the
frontend, so it already knows what changed.

### 3.4 AI

SQLPilot does not call a model (ADR-011). It exposes its live connections,
under its own policy, to the user's own harness over MCP, and can run that
harness in an in-app panel. Design: [AI_INTEGRATION.md](AI_INTEGRATION.md).
The rule that constrains the rest of the architecture: **approval for a
destructive action happens in SQLPilot's own window, whatever harness is
driving.**

### 3.5 Export

[`mas-export`](../../src-tauri/crates/mas-export/src/lib.rs) formats an
already-fetched `QueryResult` as CSV, JSON, SQL `INSERT`s or Markdown and
returns the text; `write_file_contents` writes it. Excel and XML are not
implemented. Export is bounded by the result the grid holds; it does not
stream from the server.

Import is split by format. A CSV is parsed in the renderer
(`src/lib/csv-parser.ts`) and inserted in batches through `execute_query`. A
SQL file goes to `restore_database` (§5.11), which streams it in Rust on one
connection. There is no import column-mapping engine or dry-run mode.

### 3.6 Admin

| Area                 | Where it runs                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Process list**     | `mas-admin`: `get_process_list`, `kill_process`, `kill_query`. The tab polls at an interval the user picks (off, 2s, 5s, 10s)                   |
| **Server variables** | `mas-admin`: `get_server_variables`. Setting one is a `SET` statement from the frontend                                                         |
| **Users and roles**  | Frontend-composed SQL (`src/lib/admin/`) run through `runStatement`: `CREATE USER`, `ALTER USER`, `DROP USER`, `GRANT`, `REVOKE`, `SHOW GRANTS` |
| **Server status**    | `SHOW GLOBAL STATUS` from the frontend, refreshed on an interval                                                                                |
| **Replication**      | `SHOW REPLICA STATUS` and friends, with MySQL/MariaDB spelling handled in the frontend                                                          |
| **Backup / restore** | `mas_core::backup` and `mas_core::restore` (§5.11)                                                                                              |

There is no table-maintenance UI (`OPTIMIZE`/`REPAIR`/`ANALYZE`/`CHECK`) and
no backend process monitor that pushes updates: only the admin tab in front of
the user polls, so at most one poller runs (#437).

### 3.7 Frontend State

One Zustand store per domain in [`src/stores/`](../../src/stores/):
`connectionStore`, `connectionHealthStore`, `editorStore`, `resultStore`,
`schemaStore`, `historyStore`, `favoritesStore`, `settingsStore`,
`themeStore`, `ddlStore`, `dialogStore`, `productionGuardStore`,
`storageErrorStore`, `sqliteStore`, `agentStore`, `agentSessionStore`.

The pattern:

```
Component ──► store action ──► api.* (src/lib/tauri-api.ts) ──► commands.* (src/lib/bindings.ts) ──► invoke()
```

- Components never call `api.*` directly; store actions own loading and
  error state.
- `bindings.ts` is generated from the Rust commands by tauri-specta
  (`just bindings`), so a renamed or removed command fails `tsc`.
- Every statement the app sends goes through `src/lib/run-statement.ts`,
  which records it in history tagged with its origin (`editor`, `grid`,
  `designer`, `routine`, `admin`, `schema`, `import`, `restore`, `internal`).
- `src/lib/datasource.ts` makes MySQL and SQLite connections look alike to
  the shared panes.

---

## 4. Data Flow

### 4.1 Query Execution

```
Monaco editor ── Ctrl/Cmd+Enter
      │
      ▼
resultStore.executeQuery()          loading state, production guard (§6.4)
      │
      ▼
api.executeQuery → commands.executeQuery → invoke("execute_query",
      │            { connectionId, sql, database, limit, offset, session })
      ▼
QueryExecutor (mas-core)            tab's own session, raw_sql().fetch_many()
      │
      ▼
MySQL / MariaDB                     rows streamed, kept up to the limit
      │
      ▼
Vec<QueryResult> over IPC           ≤ limit rows each, rows_truncated flag
      │
      ▼
resultStore → ResultsGrid           TanStack Table + Virtual, visible rows only
      │
      ▼
history_add                         recorded with origin "editor"
```

### 4.2 Large Result Sets

```
Frontend                         Rust backend                    MySQL
   │ execute_query(limit, offset)    │                             │
   │────────────────────────────────►│ raw_sql().fetch_many()      │
   │                                 │────────────────────────────►│
   │                                 │◄── rows, one at a time ─────│
   │                                 │  skip while offset not met  │
   │                                 │  keep until limit reached   │
   │                                 │  then drain and discard     │
   │◄── QueryResult (≤ limit rows) ──│                             │
   │    rows_truncated: true         │                             │
```

The read is streamed; the reply is not. What crosses IPC is bounded by the row
limit, so the renderer never receives more than it asked for. "Next page"
re-runs the statement with an offset.

**Why not stream rows into the grid.** An `execute_query_stream` with
per-batch events was specified early and never built. The case it was for, a
million-row result overwhelming the renderer, is what the row limit prevents;
streaming a million rows into a grid moves the problem rather than solving it.
DBeaver, TablePlus and Sequel Ace also fetch a bounded page. Streaming earns
its keep where rows never need to be in memory at once, which is why backup,
restore and SQL import stream.

**Why `execute_query` takes no parameters.** The SQL is the user's own text;
there is no app-supplied value to bind. Where values are the app's, they are
bound (`sqlx::query().bind()` in the schema inspector and admin crate).
Identifiers cannot be bound and go through `quote_ident`. Statements composed
for the user to read (a backup file, a generated `INSERT`, a DDL preview) are
text, so they escape instead: `src/lib/sql-quote.ts` on the frontend and the
backup writer in `mas_core::backup` double the quote.

### 4.3 Agent Session

The harness drives; SQLPilot answers and polices.

```
┌──────────┐        ┌──────────────────┐        ┌─────────────────────┐
│   User   │───────►│  Their harness   │───────►│ SQLPilot MCP server │
└──────────┘  asks  │ (own credentials)│  tool  │   tools + policy    │
                    └──────────────────┘  call  └──────────┬──────────┘
                                                            │
                            ┌───────────────────────────────┤
                    read or analyse                    write or DDL
                            ▼                               ▼
                  ┌──────────────────┐         ┌────────────────────────┐
                  │ posture decides  │         │ 1. stage in an open    │
                  │ what comes back: │         │    txn, count rows     │
                  │ shape / samples  │         │ 2. SQLPilot's OWN      │
                  │ / rows, redacted │         │    confirmation        │
                  └────────┬─────────┘         │ 3. commit or roll back │
                           │                   └───────────┬────────────┘
                           ▼                               ▼
                  ┌─────────────────────────────────────────────────┐
                  │ history, tagged with the session and the harness │
                  └─────────────────────────────────────────────────┘
```

Step 2 is not the harness's permission prompt. Harnesses have `--yolo`-shaped
flags; a guarantee that depends on the caller being polite is not one.

### 4.4 Connection Establishment

```
connectionStore.connect(profileId)
      │ invoke("connect", { profileId })
      ▼
ConnectionManager::connect()
  1. load profile (connections.db) and password (OS credential store)
  2. refuse if an SSH tunnel is configured (not implemented)
  3. build MySqlConnectOptions: host, port, user, TLS settings, database,
     charset, connect timeout
  4. open the interactive lane (min 1 connection); others open lazily
  5. start the health checker
      │
      ▼
ConnectionInfo back to the frontend ──► connectionStore, schemaStore loads databases
```

---

## 5. IPC Interface

Commands are `#[tauri::command]` + `#[specta::specta]` functions in
[`src-tauri/src/commands/`](../../src-tauri/src/commands/), registered once in
`specta_builder()` in [`src-tauri/src/lib.rs`](../../src-tauri/src/lib.rs).
The same list generates [`src/lib/bindings.ts`](../../src/lib/bindings.ts), so
the TypeScript and the runtime handler cannot disagree. Errors are `String`
except where noted as `QueryError` (§7).

Signatures below omit the injected `State<'_, …>` and `AppHandle` parameters.
[`scripts/check-documented-commands.sh`](../../scripts/check-documented-commands.sh)
fails CI if a name here is not registered.

### 5.1 Connection Commands

```rust
async fn save_connection_profile(profile: ConnectionProfile) -> Result<String, String>;
async fn list_connection_profiles() -> Result<Vec<ConnectionProfileSummary>, String>;
async fn delete_connection_profile(profile_id: String) -> Result<(), String>;
async fn test_connection(profile: ConnectionProfile) -> Result<TestConnectionResult, String>;
async fn connect(profile_id: String) -> Result<ConnectionInfo, String>;
async fn disconnect(connection_id: String) -> Result<(), String>;
async fn list_connections() -> Result<Vec<ConnectionInfo>, String>;
async fn connection_health(connection_id: String) -> Result<Option<ConnectionHealth>, String>;
async fn ping_connection(connection_id: String) -> Result<ConnectionHealth, String>;
async fn startup_problems() -> Result<Vec<StartupProblem>, String>;
fn keyring_available() -> bool;
```

- `list_connection_profiles` returns a summary type without credential
  fields. `ConnectionProfile`'s secrets are `#[serde(skip_serializing)]`, and
  the generated bindings split it into `_Serialize` and `_Deserialize` shapes.
- `keyring_available` is recorded once at startup, so a locked keyring never
  reads as "no password" (#527).
- `startup_problems` lists what failed before the window existed (§7.2).

### 5.2 Query Commands

```rust
async fn execute_query(connection_id: String, sql: String, database: Option<String>, limit: Option<u32>, offset: Option<u32>, session: Option<String>) -> Result<Vec<QueryResult>, QueryError>;
async fn explain_query(connection_id: String, sql: String, database: Option<String>, analyze: bool, format: Option<ExplainFormat>, session: Option<String>) -> Result<ExplainResponse, String>;
async fn cancel_query(connection_id: String, session: Option<String>) -> Result<(), String>;
async fn close_session(connection_id: String, session: String) -> Result<(), String>;
async fn apply_grid_edits(connection_id: String, session: String, database: Option<String>, statements: Vec<String>) -> Result<Option<GridEditOutcome>, QueryError>;
async fn kill_query(connection_id: String, process_id: ProcessId) -> Result<(), String>;
async fn get_own_thread_ids(connection_id: String) -> Result<Vec<ProcessId>, String>;
```

- `session` is the editor tab's id; it routes the statement to that tab's own
  server session (§3.1). `close_session` releases it when the tab closes.
- `explain_query` decides itself whether ANALYZE is safe to run (#412), and
  returns a `format_fallback` when the server lacks the requested format
  (#424).
- `kill_query` ends another connection's statement from the process list;
  `get_own_thread_ids` lets the list refuse to kill the app's own sessions.

### 5.3 Schema Commands

```rust
async fn get_databases(connection_id: String) -> Result<Vec<DatabaseInfo>, String>;
async fn get_tables(connection_id: String, database: String) -> Result<Vec<TableInfo>, String>;
async fn get_views(connection_id: String, database: String) -> Result<Vec<ViewInfo>, String>;
async fn get_routines(connection_id: String, database: String) -> Result<Vec<RoutineInfo>, String>;
async fn get_triggers(connection_id: String, database: String) -> Result<Vec<TriggerInfo>, String>;
async fn get_events(connection_id: String, database: String) -> Result<Vec<EventInfo>, String>;
async fn get_columns(connection_id: String, database: String, table: String) -> Result<Vec<ColumnInfo>, String>;
async fn get_indexes(connection_id: String, database: String, table: String) -> Result<Vec<IndexInfo>, String>;
async fn get_foreign_keys(connection_id: String, database: String, table: String) -> Result<Vec<ForeignKeyInfo>, String>;
async fn get_partitions(connection_id: String, database: String, table: String) -> Result<Vec<PartitionInfo>, String>;
async fn get_table_ddl(connection_id: String, database: String, table: String) -> Result<String, String>;
async fn get_view_ddl(connection_id: String, database: String, view_name: String) -> Result<String, String>;
async fn get_routine_ddl(connection_id: String, database: String, routine_name: String, routine_type: String) -> Result<String, String>;
async fn get_trigger_ddl(connection_id: String, database: String, trigger_name: String) -> Result<String, String>;
```

There is no schema-refresh command: the cache is the frontend's (§3.3).

### 5.4 AI Commands

None. ADR-011 made SQLPilot an MCP server rather than a model client; the
agent-facing surface is MCP tools ([AI_INTEGRATION.md](AI_INTEGRATION.md)),
and the app-side commands that decide what it may reach are §5.12.

### 5.5 Export and File Commands

```rust
async fn export_results(result: QueryResult, format: String, table_name: Option<String>) -> Result<String, String>;
async fn pick_file(title: String, filters: Vec<(String, Vec<String>)>) -> Result<Option<String>, String>;
async fn pick_save_file(title: String, default_name: String, filters: Vec<(String, Vec<String>)>) -> Result<Option<String>, String>;
async fn read_file_contents(path: String) -> Result<String, String>;
async fn write_file_contents(path: String, contents: String) -> Result<(), String>;
```

`read_file_contents` refuses files over 256 MB: the contents are held as a
Rust string, a JavaScript string and parsed rows at once (#366). A SQL import
reads only the first 512 KB in the renderer (via `read_file_head`, §5.11) to
preview it, then hands the path to `restore_database`. A transaction around a
SQL import makes a data-only file all or nothing; it cannot make DDL atomic,
because `CREATE`, `DROP` and `ALTER` commit implicitly (#365).

### 5.6 History Commands

History lives in `history.db` (§9), so every read and write crosses IPC
(#585).

```rust
async fn history_add(entry: HistoryEntry, limit: u32) -> Result<HistoryEntry, String>;
async fn history_list(query: HistoryQuery) -> Result<Vec<HistoryEntry>, String>;
async fn history_count_matching(query: HistoryQuery) -> Result<u32, String>;
async fn history_facets() -> Result<HistoryFacets, String>;
async fn history_export(query: HistoryQuery, format: HistoryExportFormat) -> Result<String, String>;
async fn history_remove(id: String) -> Result<(), String>;
async fn history_clear() -> Result<(), String>;
async fn history_count() -> Result<u32, String>;
async fn history_prune(limit: u32) -> Result<u32, String>;
async fn history_prune_older_than(cutoff: String) -> Result<u32, String>;
async fn history_import(entries: Vec<HistoryEntry>, limit: u32) -> Result<u32, String>;
```

The count limit is passed per call rather than held in the backend: it is a
UI preference, and two sources of truth would drift. Retention by age runs at
startup, not on a timer (#592). `history_import` takes over the legacy
`localStorage` history; ids carry across, so running it twice imports nothing.

### 5.7 SQLite Commands

A second backend behind the same panes (#461), for opening the user's own
SQLite files. It registers its own commands rather than pretending to answer
the MySQL ones.

```rust
async fn sqlite_open(path: String) -> Result<String, String>;
async fn sqlite_close(connection_id: String) -> Result<(), String>;
async fn sqlite_list() -> Result<Vec<String>, String>;
async fn sqlite_execute(connection_id: String, sql: String) -> Result<Vec<SqliteQueryResult>, QueryError>;
async fn sqlite_get_tables(connection_id: String) -> Result<Vec<SqliteTableInfo>, String>;
async fn sqlite_get_columns(connection_id: String, table: String) -> Result<Vec<SqliteColumnInfo>, String>;
async fn sqlite_get_indexes(connection_id: String, table: String) -> Result<Vec<SqliteIndexInfo>, String>;
async fn sqlite_get_table_ddl(connection_id: String, table: String) -> Result<String, String>;
```

`sqlite_open` checks the file header first, so a typo does not create an
empty database. `sqlite_execute` fails with the same `QueryError` as MySQL,
carrying SQLite's extended result code (#324).

### 5.8 Platform Commands

```rust
async fn get_platform_info() -> Result<PlatformInfo, String>;
```

How this build was installed and for which architecture. The updater needs it:
an in-app update must not run against a Flatpak, Snap or rpm-ostree install
(#343).

```rust
fn set_native_menu(menus: Vec<NativeMenu>) -> Result<(), String>;
```

Rebuilds the macOS menu bar from the frontend's description of it: the same
`MENUS` and `ACTIONS` the in-app menu bar renders, with each action's enabled
state and the saved profiles under Connection → Connect to (#863, #892).
`useNativeMenu` sends it whenever that changes. The description is validated
on every platform and applied only on macOS; the app starts with the static
`default_menus()` until the window sends its own.

### 5.9 Admin Commands

```rust
async fn get_process_list(connection_id: String) -> Result<Vec<ProcessInfo>, String>;
async fn kill_process(connection_id: String, process_id: ProcessId) -> Result<(), String>;
async fn get_server_variables(connection_id: String) -> Result<Vec<ServerVariable>, String>;
```

Users, roles, privileges and server status are frontend-composed SQL (§3.6),
not commands.

### 5.10 Events (Backend to Frontend)

| Event                     | Payload                       | Description                                                           |
| ------------------------- | ----------------------------- | --------------------------------------------------------------------- |
| `connection-health-event` | `ConnectionHealthEvent`       | A connection stopped answering or recovered; every attempt while down |
| `backup-progress-event`   | `BackupProgressEvent`         | Table, rows, bytes and rate for a running backup                      |
| `restore-progress-event`  | `RestoreProgressEvent`        | Bytes read and statements run for a restore or SQL import             |
| `agent-request`           | `AgentRequest`                | An agent tool call needs the window: a question or an approval        |
| `agent-session-event`     | `AgentSessionEvent`           | Streamed output from an in-app agent session                          |
| `menu-action`             | `String` (the menu item's id) | A native menu item was chosen                                         |

All but `menu-action` are generated by tauri-specta from their Rust types
(`events` in `bindings.ts`), so payload types cannot drift. `menu-action` is
emitted by name.

### 5.11 Backup Commands

A backup is written by the backend straight to the file as it reads. It used
to be built in the renderer as one string and read with `LIMIT/OFFSET`,
which was quadratic and could repeat or skip rows (#358).

```rust
async fn backup_database(backup_id: String, connection_id: String, database: String, tables: Vec<String>, options: BackupOptions, output_path: String) -> Result<BackupSummary, String>;
async fn cancel_backup(backup_id: String) -> Result<bool, String>;
async fn default_backup_options() -> Result<BackupOptions, String>;
async fn restore_database(restore_id: String, connection_id: String, database: String, input_path: String, options: RestoreOptions) -> Result<RestoreSummary, String>;
async fn default_restore_options() -> Result<RestoreOptions, String>;
async fn read_file_head(path: String, max_bytes: u32) -> Result<FileHead, String>;
```

- **No external binary.** No `mysqldump`. `mas_core::backup` reads over the
  text protocol and writes each value from the bytes the server printed, so
  `DECIMAL`, `DATETIME(6)` and `BIGINT` keep their exact values.
- **Consistency.** With `consistent_snapshot` (the default) reads happen
  inside `START TRANSACTION WITH CONSISTENT SNAPSHOT` on one connection, as
  `mysqldump --single-transaction` does. Where the server cannot (MyISAM), the
  dump says so in the file and in `BackupSummary::warnings`.
- **Cancelling removes the file.** A partial dump that looks like a dump is
  how someone restores half a database a month later. `cancel_backup` also
  stops a restore.
- `restore_database` serves both the restore dialog and SQL import.

### 5.12 Agent Commands

These do not answer agents. They decide what agents can reach and where they
connect. Tool calls never come through Tauri: they arrive over HTTP at the
endpoint in
[`src-tauri/crates/mas-mcp/src/endpoint.rs`](../../src-tauri/crates/mas-mcp/src/endpoint.rs),
wired to app state in [`src-tauri/src/mcp/`](../../src-tauri/src/mcp/).

```rust
async fn list_agent_connections() -> Result<Vec<AgentConnection>, String>;
async fn share_connection_with_agents(connection_id: String, posture: DataPosture, databases: Option<Vec<String>>, redact: Option<Vec<String>>) -> Result<(), String>;
async fn revoke_agent_connection(connection_id: String) -> Result<(), String>;
async fn unlock_agent_ddl(connection_id: String, unlocked: bool) -> Result<(), String>;
async fn agent_endpoint_status() -> Result<AgentEndpoint, String>;
async fn start_agent_endpoint() -> Result<AgentEndpoint, String>;
async fn stop_agent_endpoint() -> Result<AgentEndpoint, String>;
async fn rotate_agent_token() -> Result<AgentEndpoint, String>;
async fn agent_harness_setup(harness: SetupTarget) -> Result<String, String>;
async fn answer_agent_request(id: String, value: Option<String>, error: Option<String>) -> Result<(), String>;
```

- Nothing is shared until `share_connection_with_agents` says so. The posture
  (schema-only, samples, or full) decides how much real data may leave the
  database; `redact` adds column-name patterns to hide. An empty `databases`
  list means every database.
- `unlock_agent_ddl` permits schema changes on a production connection for
  this session only; it is never persisted.
- `rotate_agent_token` issues a new bearer token; a running endpoint restarts
  on it.
- `answer_agent_request` is the return leg of `agent-request`. An id nobody
  is waiting for is ignored: the request may have timed out a moment before
  the user clicked.

**Sessions.** A session is the user's own harness CLI, spawned by SQLPilot
with the MCP endpoint handed to it at startup, in its own working directory
under the app's data folder. Copilot is driven over the
[Agent Client Protocol](https://agentclientprotocol.com) (`copilot --acp`);
Claude Code over its own NDJSON stream. `mas-agent` normalises both into one
`SessionEvent` stream.

```rust
async fn list_harnesses() -> Result<Vec<HarnessStatus>, String>;
async fn start_agent_session(harness: Harness) -> Result<StartedSession, String>;
async fn send_agent_message(session: String, text: String) -> Result<(), String>;
async fn cancel_agent_turn(session: String) -> Result<(), String>;
async fn answer_agent_permission(session: String, request: String, option: Option<String>) -> Result<(), String>;
async fn stop_agent_session(session: String) -> Result<(), String>;
```

SQLPilot never installs or authenticates a harness. `send_agent_message`
returns at once; the answer arrives as `agent-session-event`s so a turn can be
cancelled.

**Approving a change.** A write from an agent goes:

1. `run_write` classifies the statement and asks the policy. A read-only
   connection refuses here.
2. The statement runs inside a transaction that is **not committed**, on a
   connection held out of the pool (`mas_core::query::staged`).
3. The user is asked in SQLPilot's window, with the **measured** row count,
   the connection, its environment and the agent's stated reason.
4. Their answer commits or rolls back. A dismissal, a timeout, or a window
   that never answered all roll back.

A staged write rolls itself back after `DEFAULT_DEADLINE` (two minutes),
because it holds row locks while it waits. DDL cannot be staged: MySQL and
MariaDB commit the open transaction before a schema change (verified in
`mas-core/tests/staged_write.rs`). So `run_ddl` is approved before it runs,
with no row count, and refused on production unless that connection has been
unlocked.

Grants are stored in `connections.db` (`agent_grants`) and deleted with their
connection. The bearer token is a 0600 file in the data directory rather than
a keyring entry: the user has to be able to read it to paste it into their
harness.

## 6. Security Architecture

The threat model and CSP rationale are in [`../SECURITY.md`](../SECURITY.md).

### 6.1 Credential Storage

```
Frontend: save_connection_profile({ ...profile, password })
      │      the only time a plaintext password crosses IPC
      ▼
mas_core::connection::store
      │  keyring entry: service "sqlpilot.connection_profiles", key = profile id
      ▼
OS credential store (keyring-core, one native store per platform)
  Windows: Credential Manager   (windows-native-keyring-store)
  macOS:   Keychain             (apple-native-keyring-store)
  Linux:   Secret Service       (dbus-secret-service-keyring-store)
           falls back to kernel keyutils (linux-keyutils-keyring-store)
```

- The `password` column in `connection_profiles` is left empty. Plaintext
  passwords from older versions are moved into the store on load and the
  column cleared. SSH passwords and passphrases use their own keyring slots.
- Passwords are never serialized back to the frontend
  (`#[serde(skip_serializing)]`).
- On Linux the Secret Service (GNOME Keyring, KWallet) is used whenever the
  session has one. Without it the app falls back to kernel keyutils, which
  is in memory only: saved passwords last until the next reboot (#877).
- With no credential store at startup, the app runs anyway: profiles work,
  passwords are not remembered, and the status bar says so (#278). A store
  that is merely locked is not treated as "no password", so a save cannot
  delete the credential (#274).

### 6.2 Tauri Security Model

| Layer                       | Configuration                                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Commands**                | Only the commands in `specta_builder()` are callable.                                                                                                |
| **Capabilities**            | [`src-tauri/capabilities/`](../../src-tauri/capabilities/) grants the plugin permissions the window needs.                                           |
| **Content Security Policy** | Set in `src-tauri/tauri.conf.json`. Monaco forces `'unsafe-eval'` and inline styles; `worker-src 'self' blob:` for its worker. See `../SECURITY.md`. |
| **No remote content**       | The frontend is bundled; the webview loads no remote URLs.                                                                                           |

### 6.3 Network Security

| Scenario            | Protection                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Database**        | Optional TLS per profile (sqlx with rustls), with CA and client certificate paths. No integration test covers it yet                                                      |
| **SSH tunnel**      | Not implemented; a profile configured for one is refused                                                                                                                  |
| **Agent endpoint**  | `127.0.0.1` only. Bearer token in a 0600 file, rotatable. Requests carrying an `Origin` header are refused: no harness sends one, and it is what DNS rebinding would need |
| **Model API calls** | None. SQLPilot holds no key (ADR-011)                                                                                                                                     |

### 6.4 Destructive Operation Safeguards

- **Read-only profiles** are enforced in the backend.
- **Production connections** (profile environment set to production): a
  statement that `src/lib/sql-safety.ts` classes as destructive (`DROP`,
  `DELETE`, `TRUNCATE`, `ALTER`, `RENAME`, `GRANT`, `REVOKE`, `KILL`, `FLUSH`,
  `SHUTDOWN`, `SET PASSWORD`, `SET GLOBAL` and similar) raises a confirmation through `confirmDestructive`
  (`src/stores/productionGuardStore.ts`) before it runs. Editor runs, grid
  saves, imports, restores and admin dialogs all go through it.
- **Dropping a database** from the schema tree asks for its name to be typed.
- **Agent writes and DDL** always wait for approval in SQLPilot's window
  (§5.12), with no setting that skips it.
- Every statement is recorded in history with its origin; that is the audit
  trail. There is no separate audit log.

---

## 7. Error Handling

### 7.1 Error Types

- **`CoreError`** ([`mas-core/src/error.rs`](../../src-tauri/crates/mas-core/src/error.rs))
  is the backend's error enum (connection, query, schema, auth, SSL, storage,
  not found, timeout, cancelled, read-only, pool exhausted, out of memory,
  plus wrapped sqlx, rusqlite, serde and anyhow errors). It serializes as its
  message string.
- Most commands return `Result<T, String>` via `.map_err(|e| e.to_string())`.
- **`QueryError`** is returned where the frontend has to act on the failure
  (`execute_query`, `apply_grid_edits`, `sqlite_execute`): `message`, driver
  `code` (MySQL error number or SQLite extended code), `sqlState`, and the
  `statementIndex` that failed (#324, #329). It serializes camelCase.

### 7.2 Graceful Degradation

**Nothing in startup panics.** A process that dies before a window exists
leaves a message in a terminal the desktop user does not have open. Each
startup failure becomes a `StartupProblem` (a kind, a summary in the user's
terms, and the underlying error), read once by the status bar through
`startup_problems`.

| What is missing            | What happens                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **OS credential store**    | Passwords are not remembered between sessions; the status bar says so                                                        |
| **The data directory**     | Falls back to a temp directory, then to the working directory, and says settings may not survive a restart                   |
| **The log directory**      | Console logging only                                                                                                         |
| **`connections.db`**       | Starts with an in-memory store; the file is left untouched so it can be recovered                                            |
| **`history.db`**           | Starts with an in-memory store: this session's history is not kept, everything else works                                    |
| **SSH tunnelling**         | Not implemented; a profile configured for one is refused, rather than connecting direct while the UI implies a tunnel (#273) |
| **An agent harness**       | The agent panel says how to install one; everything else works                                                               |
| **A server that has gone** | The health checker marks it and keeps trying (§3.1)                                                                          |

### 7.3 Frontend

- A top-level `ErrorBoundary` (`src/components/common/ErrorBoundary.tsx`)
  wraps the app.
- IPC errors are caught in store actions, which own the error state shown by
  the component.
- Query errors are shown in the results pane with the server's code and the
  failing statement.
- `localStorage` write failures are surfaced through `storageErrorStore`
  rather than lost.

---

## 8. Performance

What is actually done, and why it is enough:

- **Bounded results** (§4.2): the renderer holds one page, whatever the
  result size.
- **Row virtualization**: TanStack Virtual renders only the visible rows of
  the grid.
- **Lazy schema tree**: databases load on connect; a database's objects on
  expand; columns on demand.
- **Lanes, not one pool** (§3.1): a long dump or an agent cannot starve the
  schema tree or an editor tab.
- **Streaming where rows need not be held**: backup, restore and SQL import.
- **Small Monaco build** (§2).

The performance targets are non-functional requirements in
[DESIGN_REQUIREMENTS.md](DESIGN_REQUIREMENTS.md). There is no benchmark suite.

---

## 9. Local Storage

Two tiers: SQLite files and logs in the app data directory on the Rust side,
and `localStorage` for UI preferences on the frontend.

### Data Directory

`dirs::data_dir()/sqlpilot`: `$XDG_DATA_HOME/sqlpilot` (usually
`~/.local/share/sqlpilot`) on Linux, `~/Library/Application Support/sqlpilot`
on macOS, `%APPDATA%\sqlpilot` on Windows.

```
sqlpilot/
├── connections.db      connection_profiles, agent_grants (no passwords)
├── history.db          query_history, WAL mode
├── logs/
│   └── sqlpilot.log.YYYY-MM-DD    JSON, DEBUG level, rolled daily
└── (agent endpoint token file and per-session working directories)
```

History is a separate file so an append-only log that grows cannot take the
connection profiles down with it.

### SQLite Schemas

Both databases use versioned migrations with `PRAGMA user_version` as the
cursor, each migration in its own transaction:

- `connections.db`:
  [`mas-core/src/connection/migrations.rs`](../../src-tauri/crates/mas-core/src/connection/migrations.rs).
  `connection_profiles` (profile fields, `env`, timeouts, `charset`; SSH and
  SSL config as JSON) and `agent_grants` (posture, databases, redaction
  patterns; cascades on profile delete).
- `history.db`:
  [`mas-core/src/history/migrations.rs`](../../src-tauri/crates/mas-core/src/history/migrations.rs).
  `query_history` with an `origin` column, indexed by `executed_at`.

History keeps the last N entries (default 500, set in the history panel) and
optionally a maximum age. Search is a `LIKE` with an explicit `ESCAPE`. A
statement over `MAX_SQL_BYTES` (256 KB) is stored cut and marked `truncated`.
Credentials in statements (`IDENTIFIED BY '…'` and the like) are redacted
before storage, and all literals can be (`src/lib/sql-redact.ts`).

### localStorage Keys

| Key                                | Owner                       | Contents                                        |
| ---------------------------------- | --------------------------- | ----------------------------------------------- |
| `theme`                            | `themeStore.ts`             | theme id, or `"system"`                         |
| `sqlpilot.custom-themes`           | `themeStore.ts`             | JSON `Theme[]`, re-validated on read (#350)     |
| `sqlpilot-formatter-settings`      | `settingsStore.ts`          | JSON `FormatterSettings`                        |
| `sqlpilot-query-settings`          | `settingsStore.ts`          | JSON query settings (row limit and the like)    |
| `sqlpilot-history-limit`           | `historyStore.ts`           | number: entries to keep                         |
| `sqlpilot-history-max-age-days`    | `historyStore.ts`           | number: retention in days                       |
| `sqlpilot-history-redact-literals` | `historyStore.ts`           | boolean                                         |
| `mas-query-favorites`              | `favoritesStore.ts`         | JSON via `zustand/middleware` `persist`         |
| `sqlpilot-editor-session`          | `src/lib/editor-session.ts` | JSON `{ tabs, activeTabId }`, debounced save    |
| `sqlpilot.grid-layout…`            | `src/lib/grid-layout.ts`    | per-result column layout (key prefix)           |
| `mas-query-history`                | `historyStore.ts`           | legacy; imported into `history.db` then removed |

The webview's `localStorage` lives in the webview's own profile for the bundle
identifier `com.sqlpilot.app`, separate from the data directory above.
Favorites export and import is a user-chosen JSON file.

---

## Appendix A: Glossary

| Term                   | Definition                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------- |
| **IPC**                | The message channel between the Rust backend and the webview                        |
| **Tauri command**      | A Rust function annotated `#[tauri::command]`, callable from JavaScript             |
| **Tauri event**        | A named, typed message emitted from Rust and received by JavaScript listeners       |
| **Connection profile** | A saved set of parameters for connecting to a MySQL or MariaDB server               |
| **Lane**               | One of a live connection's pools: interactive, per-tab session, agent, or job       |
| **Harness**            | An agent CLI the user runs (Claude Code, Copilot), which reaches SQLPilot over MCP  |
| **Posture**            | How much real data a shared connection may return to an agent                       |
| **DDL / DML**          | Statements that change schema (CREATE, ALTER, DROP) / data (INSERT, UPDATE, DELETE) |
