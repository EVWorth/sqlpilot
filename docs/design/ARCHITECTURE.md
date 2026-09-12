# SQLPilot — Software Architecture Document

> **Version:** 1.0.0
> **Last Updated:** 2025-07-15
> **Status:** Living Document

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Technology Stack Details](#2-technology-stack-details)
3. [Component Architecture](#3-component-architecture)
4. [Data Flow Diagrams](#4-data-flow-diagrams)
5. [IPC Interface Design](#5-ipc-interface-design)
6. [Security Architecture](#6-security-architecture)
7. [Error Handling Strategy](#7-error-handling-strategy)
8. [Performance Optimization Strategies](#8-performance-optimization-strategies)
9. [Local Storage Architecture](#9-local-storage-architecture)
10. [Plugin Architecture (Future)](#10-plugin-architecture-future)

---

## 1. Architecture Overview

SQLPilot is a cross-platform desktop application built on a **two-process architecture**: a Rust backend (Tauri 2) handles all database operations, file I/O, and system integration, while a React/TypeScript frontend renders the UI inside a native webview. The two halves communicate exclusively through Tauri's IPC bridge — a strongly-typed, JSON-serialized command/event channel.

### High-Level System Diagram

```
┌─────────────────────────────────────────────────────┐
│                   Frontend (React)                   │
│  ┌────────────┐ ┌────────────┐ ┌──────────────────┐ │
│  │ SQL Editor  │ │ Data Grid  │ │ Schema Explorer  │ │
│  │  (Monaco)   │ │ (TanStack) │ │   (Tree View)    │ │
│  └────────────┘ └────────────┘ └──────────────────┘ │
│  ┌────────────┐ ┌────────────┐ ┌──────────────────┐ │
│  │   Table     │ │  Backup /  │ │   Agent Session  │ │
│  │  Designer   │ │  Restore   │ │  (bring your own)│ │
│  └────────────┘ └────────────┘ └──────────────────┘ │
│  ┌────────────┐ ┌────────────┐ ┌──────────────────┐ │
│  │   Admin     │ │ Resizable  │ │   Settings /     │ │
│  │   Panel     │ │  Panels    │ │   Preferences    │ │
│  └────────────┘ └────────────┘ └──────────────────┘ │
├─────────────────────────────────────────────────────┤
│               Tauri IPC Bridge                       │
│         (Commands ↑↓ Events / Streaming)             │
├─────────────────────────────────────────────────────┤
│                   Backend (Rust)                      │
│  ┌────────────┐ ┌────────────┐ ┌──────────────────┐ │
│  │ Connection  │ │   Query    │ │    MCP Server    │ │
│  │  Manager    │ │  Executor  │ │  (tools+policy)  │ │
│  └────────────┘ └────────────┘ └──────────────────┘ │
│  ┌────────────┐ ┌────────────┐ ┌──────────────────┐ │
│  │   Schema    │ │   Export   │ │  Admin Service   │ │
│  │  Inspector  │ │  Service   │ │                  │ │
│  └────────────┘ └────────────┘ └──────────────────┘ │
│  ┌────────────┐ ┌────────────┐ ┌──────────────────┐ │
│  │  Keyring /  │ │  Local DB  │ │   Logging /      │ │
│  │ Credentials │ │ (rusqlite) │ │   Tracing        │ │
│  └────────────┘ └────────────┘ └──────────────────┘ │
├─────────────────────────────────────────────────────┤
│          MySQL Servers (via sqlx + SSH/SSL)           │
│  ┌────────────┐ ┌────────────┐ ┌──────────────────┐ │
│  │  Local DB   │ │  Remote DB │ │ Cloud DB (RDS,   │ │
│  │             │ │  (SSH)     │ │ PlanetScale, ..) │ │
│  └────────────┘ └────────────┘ └──────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### Process Model

```
┌──────────────────────────────────────────────────────────────┐
│  OS Process: sqlpilot                                  │
│                                                               │
│  ┌──────────────────────┐    ┌─────────────────────────────┐ │
│  │   Main Thread (Rust) │    │   Webview Thread (Frontend) │ │
│  │                      │    │                             │ │
│  │  • Tauri runtime     │◄──►│  • React application        │ │
│  │  • IPC handler       │IPC │  • Monaco Editor            │ │
│  │  • Window management │    │  • UI rendering             │ │
│  │                      │    │                             │ │
│  └──────────┬───────────┘    └─────────────────────────────┘ │
│             │                                                 │
│  ┌──────────▼───────────┐                                    │
│  │  Tokio Thread Pool   │                                    │
│  │                      │                                    │
│  │  • Query execution   │                                    │
│  │  • SSH tunnels       │                                    │
│  │  • MCP over loopback │                                    │
│  │  • Export operations  │                                    │
│  │  • Schema inspection  │                                    │
│  └──────────────────────┘                                    │
└──────────────────────────────────────────────────────────────┘
```

### Key Architectural Principles

| Principle                  | Description                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Separation of Concerns** | All database I/O and OS integration lives in Rust; the frontend is purely presentational and state-management                                                      |
| **Async Everywhere**       | Every backend operation is non-blocking, powered by Tokio; the UI thread is never starved                                                                          |
| **Stream by Default**      | Large result sets and exports are streamed, not buffered; memory usage stays constant regardless of data size                                                      |
| **Offline First**          | Nothing requires a network beyond the MySQL target. The app never calls a model; an agent session is the user's own harness, which they may point at a local model |
| **Security by Design**     | Credentials never leave the OS keychain; no secrets traverse IPC; Tauri's CSP and allowlist are strictly configured                                                |

---

## 2. Technology Stack Details

### Frontend Stack

| Technology                 | Purpose          | Version | Rationale                                                                                                                                                                                                                                                                                   |
| -------------------------- | ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **React**                  | UI Framework     | 18+     | Largest ecosystem, extensive component library support, concurrent rendering                                                                                                                                                                                                                |
| **TypeScript**             | Type Safety      | 5.x     | Catch errors at compile time, superior IDE experience, self-documenting APIs                                                                                                                                                                                                                |
| **Vite**                   | Build Tool       | 5.x     | Sub-second HMR, ESBuild-powered bundling, first-class Tauri integration                                                                                                                                                                                                                     |
| **TanStack Table**         | Data Grid        | v8      | Headless & virtualized, handles 1M+ rows, fully customizable rendering                                                                                                                                                                                                                      |
| **TanStack Virtual**       | Virtualization   | v3      | Smooth scrolling for large datasets, row and column virtualization                                                                                                                                                                                                                          |
| **Monaco Editor**          | SQL Editor       | Latest  | VS Code's editor engine. Imported as `editor.all` plus the SQL and MySQL language contributions, **not** the `monaco-editor` barrel: that barrel carries the TypeScript, CSS, HTML and JSON language services, whose workers are 10.8 MB of a build that never edits any of those languages |
| **Zustand**                | State Management | v5      | Lightweight, no boilerplate, supports middleware and devtools                                                                                                                                                                                                                               |
| **Tailwind CSS**           | Styling          | v4      | Utility-first, dark/light theming via CSS variables, minimal CSS bundle                                                                                                                                                                                                                     |
| **sql-formatter**          | SQL Formatting   | Latest  | Formatting is the frontend's; a round trip to Rust to reformat the text the user is typing would buy nothing                                                                                                                                                                                |
| **React Resizable Panels** | Layout           | Latest  | Draggable panel system, persistent sizes, nested layouts                                                                                                                                                                                                                                    |
| **@tauri-apps/api**        | Tauri Bridge     | 2.x     | Type-safe IPC invoke/listen, file dialogs, window management                                                                                                                                                                                                                                |

### Backend Stack

| Technology             | Purpose       | Version | Rationale                                                                      |
| ---------------------- | ------------- | ------- | ------------------------------------------------------------------------------ |
| **Rust**               | Language      | 1.75+   | Memory safety without GC, zero-cost abstractions, fearless concurrency         |
| **Tauri**              | App Framework | 2.x     | ~3 MB binary, OS-native webview, granular permission system                    |
| **sqlx**               | MySQL Driver  | 0.7+    | Async, compile-time checked queries, connection pooling, TLS built-in          |
| **tokio**              | Async Runtime | 1.x     | Industry-standard async executor, timers, channels, task spawning              |
| **serde**              | Serialization | 1.x     | Derive-based JSON/TOML/YAML (de)serialization, zero-copy where possible        |
| **ssh2**               | SSH Tunneling | 0.9+    | libssh2 bindings, public key and password auth, local port forwarding          |
| **keyring**            | Credentials   | 2.x     | Windows Credential Manager, macOS Keychain, Linux Secret Service/GNOME Keyring |
| **rusqlite**           | Local Storage | 0.31+   | Embedded SQLite for connection profiles, query history, settings               |
| **tracing**            | Logging       | 0.1+    | Structured, async-aware logging with span-based context propagation            |
| **tracing-subscriber** | Log Output    | 0.3+    | Formatters for console and file output, filtering by level/module              |
| **uuid**               | Identifiers   | 1.x     | UUIDv4 generation for connection IDs, session IDs, query handles               |
| **thiserror**          | Error Types   | 1.x     | Derive macro for ergonomic, typed error enums                                  |
| **anyhow**             | Error Context | 1.x     | Contextual error wrapping for debugging, `.context("msg")` chains              |
| **chrono**             | Date/Time     | 0.4+    | Timezone-aware datetime handling for MySQL temporal types                      |

### Development & Build Tools

| Tool                  | Purpose                                       |
| --------------------- | --------------------------------------------- |
| **Tauri CLI**         | Build, dev server, bundling for all platforms |
| **Cargo**             | Rust dependency management and compilation    |
| **pnpm**              | Fast, disk-efficient JS package manager       |
| **ESLint + Prettier** | Code style enforcement                        |
| **Clippy**            | Rust linting                                  |
| **Vitest**            | Frontend unit tests                           |
| **Playwright**        | End-to-end testing                            |
| **GitHub Actions**    | CI/CD for multi-platform builds               |

---

## 3. Component Architecture

### 3.1 Connection Manager (Rust)

The Connection Manager is the central backend service responsible for the full lifecycle of MySQL connections — from profile storage to pooled, health-checked, tunnel-wrapped database sessions.

#### Core Structures

```rust
/// Persisted connection profile — everything needed to establish a connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionProfile {
    pub id: String,                          // UUIDv4
    pub name: String,                        // User-friendly label
    pub group: Option<String>,               // Logical grouping ("Production", "Dev")
    pub color: Option<String>,               // Hex color for tab/badge
    pub host: String,
    pub port: u16,                           // Default: 3306
    pub username: String,
    pub password_ref: PasswordRef,           // Reference to OS keychain entry
    pub default_database: Option<String>,
    pub ssh_config: Option<SSHConfig>,
    pub ssl_config: Option<SSLConfig>,
    pub pool_config: PoolConfig,
    pub read_only: bool,                     // Prevent accidental writes
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SSHConfig {
    pub host: String,
    pub port: u16,                           // Default: 22
    pub username: String,
    pub auth: SSHAuth,                       // Password | PrivateKey { path, passphrase }
    pub keepalive_interval: Option<u64>,     // Seconds
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SSLConfig {
    pub mode: SSLMode,                       // Disabled | Preferred | Required | VerifyCA | VerifyIdentity
    pub ca_cert_path: Option<PathBuf>,
    pub client_cert_path: Option<PathBuf>,
    pub client_key_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolConfig {
    pub min_connections: u32,                // Default: 1
    pub max_connections: u32,                // Default: 5
    pub idle_timeout_secs: u64,             // Default: 300
    pub max_lifetime_secs: u64,             // Default: 1800
}
```

#### Sub-Components

| Component              | Responsibility                                                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ConnectionPool**     | Wraps `sqlx::MySqlPool`. Pool sizing comes from the profile and is clamped to 1–50 (FR-1.2.3); sqlx reopens a pooled connection by itself, so a server that comes back is usable without anything being torn down     |
| **SSHTunnel**          | **NOT IMPLEMENTED.** A profile configured for a tunnel is refused rather than connected directly, which is what it used to do (#273)                                                                                  |
| **ConnectionRegistry** | Thread-safe, in-memory `DashMap<String, ActiveConnection>` of all live connections indexed by connection ID                                                                                                           |
| **ConnectionStore**    | `rusqlite`-backed persistence of `ConnectionProfile` records; passwords stored separately in the OS keychain via `keyring`                                                                                            |
| **HealthChecker**      | Background task per connection: `SELECT 1` every 15s, backing off to the FR-1.2.4 schedule while a connection is down. Reports through `connection-health-event`; the task ends when the connection is removed (#276) |

#### Health checks and backoff

A healthy connection is pinged every 15 seconds. From the first failed ping the
gaps follow FR-1.2.4 — 1s, 2s, 4s, 8s, 16s, then 30s capped — until one
succeeds, at which point the interval returns to normal.

```
healthy      ──► SELECT 1 every 15s, reported only when the state changes
first failure──► marked lost, reported on every attempt so the UI can count them
retries      ──► 1s, 2s, 4s, 8s, 16s, 30s, 30s …
recovery     ──► marked healthy, reported once
```

There is no separate reconnect step and no attempt limit. Nothing is torn down
when a connection is lost: sqlx opens a fresh pooled connection when one is
next asked for, so a server that comes back is usable again without the user
doing anything. The status bar shows the state and the number of attempts;
`ping_connection` checks on demand.

No jitter. It exists to stop a thousand clients retrying in lockstep; a
desktop client with a handful of connections has no herd to disperse.

#### Connection Lifecycle

```
save_profile() ──► ConnectionStore (rusqlite) + keyring
       │
       ▼
  connect() ──► SSHTunnel::establish() (if SSH)
       │              │
       │              ▼
       │        Local port allocated
       │              │
       ▼              ▼
  sqlx::MySqlPoolOptions::connect_with()
       │
       ▼
  Health check: SELECT 1
       │
       ▼
  ConnectionRegistry::insert(id, ActiveConnection)
       │
       ▼
  Start HealthChecker background task (ends when the connection is removed)
```

---

### 3.2 Query Executor (Rust)

The Query Executor handles every SQL statement sent from the frontend — from simple `SELECT`s to multi-statement scripts with mixed DDL/DML.

#### Core Trait

```rust
#[async_trait]
pub trait QueryExecutor: Send + Sync {
    /// Execute a single SQL statement, returning metadata + rows.
    async fn execute(
        &self,
        connection_id: &str,
        sql: &str,
        // Not implemented, and not planned. The SQL is the user's own text,
        // typed into the editor — there is no application-supplied value to
        // bind. Everything the app composes itself is built in Rust with
        // `sqlx::query().bind()`, which is where binding belongs. See
        // "On parameterized queries" below (#285).
        limit: Option<u64>,
        offset: Option<u64>,
    ) -> Result<QueryResult, QueryError>;

    /// Cancel a running query by its handle.
    async fn cancel(&self, query_id: &str) -> Result<(), QueryError>;

    /// Run EXPLAIN [ANALYZE] on a query.
    async fn explain(
        &self,
        connection_id: &str,
        sql: &str,
        analyze: bool,
    ) -> Result<ExplainResult, QueryError>;
}
```

#### Features

| Feature                       | Implementation                                                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bounded results**           | Rows are read from a stream and the read stops at the configured row limit (default 1000); paging re-runs the statement and discards rows to reach an offset. See "On streaming" below (#284). |
| **Query cancellation**        | Each query runs inside a `tokio::select!` with a cancellation token. On cancel, a separate connection sends `KILL QUERY <id>` to the MySQL server.                                             |
| **Transaction tracking**      | A per-connection state machine tracks `BEGIN` / `COMMIT` / `ROLLBACK` transitions. The UI displays the current transaction state.                                                              |
| **Timing & statistics**       | Every execution records: wall-clock time, rows affected/returned, bytes transferred, warnings count.                                                                                           |
| **Parameterized queries**     | Used throughout the app's own queries (`sqlx::query().bind()`). Not exposed on `execute_query`, which runs the user's own SQL — see below (#285).                                              |
| **Multi-statement execution** | Statements are split by `;` (respecting string literals and comments), executed sequentially, and each result set is tagged with its statement index.                                          |
| **EXPLAIN integration**       | One-click EXPLAIN or EXPLAIN ANALYZE with visual tree rendering on the frontend.                                                                                                               |

#### Result Structures

```rust
#[derive(Debug, Serialize)]
pub struct QueryResult {
    pub query_id: String,
    pub statement_index: usize,            // For multi-statement results
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<SqlValue>>,
    pub rows_affected: u64,
    pub execution_time_ms: u64,
    pub warnings: Vec<String>,
    pub is_partial: bool,                  // True if streaming, more rows coming
}

#[derive(Debug, Serialize)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,                 // e.g. "VARCHAR(255)", "INT UNSIGNED"
    pub nullable: bool,
    pub is_primary_key: bool,
    pub max_display_width: Option<u32>,
}
```

---

### 3.3 Schema Inspector (Rust)

The Schema Inspector provides the backend's view of every MySQL server's metadata — databases, tables, columns, indexes, foreign keys, routines, and more.

#### Data Sources

| MySQL Source                                        | What We Read                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| `INFORMATION_SCHEMA.SCHEMATA`                       | Database list, default character set, collation                       |
| `INFORMATION_SCHEMA.TABLES`                         | Table/view names, engine, row count estimate, data/index size         |
| `INFORMATION_SCHEMA.COLUMNS`                        | Column name, type, nullable, default, extra (auto_increment), comment |
| `INFORMATION_SCHEMA.STATISTICS`                     | Index name, columns, uniqueness, type (BTREE/HASH/FULLTEXT)           |
| `INFORMATION_SCHEMA.KEY_COLUMN_USAGE`               | Foreign key relationships                                             |
| `INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS`        | ON DELETE / ON UPDATE rules                                           |
| `INFORMATION_SCHEMA.TRIGGERS`                       | Trigger name, event, timing, statement                                |
| `INFORMATION_SCHEMA.ROUTINES`                       | Stored procedures and functions                                       |
| `INFORMATION_SCHEMA.EVENTS`                         | Scheduled events                                                      |
| `INFORMATION_SCHEMA.PARTITIONS`                     | Partition definitions                                                 |
| `performance_schema.threads`                        | Active thread/connection metrics                                      |
| `mysql.user` / `INFORMATION_SCHEMA.USER_PRIVILEGES` | User accounts and grants                                              |

#### Caching Strategy

The cache is in the frontend, in `src/stores/schemaStore.ts`, keyed by
connection. There is no backend cache and no TTL.

```
┌───────────────────────────────────────────────────┐
│        schemaStore.byConnection[connectionId]      │
│                                                     │
│  databases  DatabaseInfo[]                          │
│  tables     { [database]: TableInfo[] }             │
│  views      { [database]: ViewInfo[] }              │
│  routines   { [database]: RoutineInfo[] }           │
│  triggers   { [database]: TriggerInfo[] }           │
│  events     { [database]: EventInfo[] }             │
│  columns    { "database.table": ColumnInfo[] }      │
│  generation number  — see below                     │
│                                                     │
│  Invalidation:                                      │
│    invalidate(conn)                 everything      │
│    invalidate(conn, db)             one database,   │
│                                     every folder    │
│    invalidate(conn, db, folder)     one folder      │
│    forget(conn)                     on disconnect   │
└───────────────────────────────────────────────────┘
```

A **generation counter** per connection, held outside the store so it survives
`forget`, is what makes concurrency safe: a fetch captures it before awaiting
and drops its result if it no longer matches. That is what stops a response
from a connection the user has left, or from before a refresh, overwriting
what replaced it (#288).

##### Why no TTL

Earlier drafts specified per-object-type TTLs (60s databases, 30s tables, and
so on). None was implemented, and on reflection a TTL answers the wrong
question. A schema does not drift on a timer; it changes when someone runs
DDL. A 30-second TTL re-reads a schema nobody has touched all afternoon and
still shows a stale tree for up to 30 seconds after a change the app itself
made.

Invalidation is explicit instead: the app invalidates what it changed when it
changes it, and the user has Refresh for changes made elsewhere. If a
staleness window is wanted later, it belongs on the object types that actually
churn rather than on all of them.

##### Why no `schema_changed` event

Earlier drafts had the backend emit a Tauri `schema_changed` event that the
frontend would use to surgically update the tree. It was never implemented,
and it is not needed: the frontend is where DDL is issued from, so it already
knows what changed and invalidates exactly that. An event would be the right
shape if the backend could change the schema on its own — it cannot.

The `schema_changed` entry in the event table below is removed for the same
reason.

---

### 3.4 AI — see AI_INTEGRATION.md

There is no AI service in this codebase, and by ADR-011 there will not be one:
SQLPilot does not call a model. It exposes its live connections, under its own
policy, to whatever harness the user already runs — **bring your own harness**.

This section used to describe a Copilot SDK session with a prompt builder, a
provider abstraction, a rate limiter and a token budget. The `mas-ai` crate
that implemented part of it has been removed; the rate limiter and the token
budget were never built and are the harness's concern now.

The replacement is designed in [AI_INTEGRATION.md](AI_INTEGRATION.md): an MCP
server over the live connections, the policy that grades every call, and an
in-app session view. The one rule worth repeating here, because it constrains
the rest of the architecture: **approval for a destructive action happens in
SQLPilot's own window, whatever harness is driving.**

---

### 3.5 Export Service (Rust)

The Export Service provides pluggable, streaming data export from query results or entire tables.

#### Exporter Trait

```rust
#[async_trait]
pub trait DataExporter: Send + Sync {
    /// File extension for this format (e.g., "csv", "json").
    fn extension(&self) -> &str;

    /// MIME type (e.g., "text/csv").
    fn mime_type(&self) -> &str;

    /// Stream rows from source into the writer.
    async fn export<W: AsyncWrite + Unpin + Send>(
        &self,
        columns: &[ColumnMeta],
        rows: Pin<Box<dyn Stream<Item = Result<Row, Error>> + Send>>,
        writer: &mut W,
        progress: &dyn ProgressReporter,
    ) -> Result<ExportStats, ExportError>;
}
```

#### Supported Formats

| Exporter             | Extension | Features                                                                     |
| -------------------- | --------- | ---------------------------------------------------------------------------- |
| **CSVExporter**      | `.csv`    | Configurable delimiter, quoting, headers, encoding (UTF-8/Latin-1)           |
| **JSONExporter**     | `.json`   | Array-of-objects or array-of-arrays, pretty-print option                     |
| **SQLExporter**      | `.sql`    | INSERT statements, CREATE TABLE included optionally, batch size configurable |
| **MarkdownExporter** | `.md`     | GitHub-flavored Markdown tables, alignment                                   |

> **Note:** Excel (`.xlsx`) and XML (`.xml`) exporters listed in earlier revisions are not implemented. The crate currently ships 4 formats.

#### Streaming Architecture

```
MySQL Server
    │
    ▼  (rows fetched in batches of 1000)
sqlx::query().fetch()
    │
    ▼  (each batch)
DataExporter::export() ──► Write to AsyncWrite (file / buffer)
    │
    ▼  (every N rows)
ProgressReporter::report() ──► Tauri event: "export_progress"
    │                                │
    │                                ▼
    │                          Frontend progress bar
    ▼
ExportStats { rows_exported, bytes_written, duration_ms }
```

#### Import Counterparts

Each export format has a corresponding importer that supports:

- **Column mapping** — source columns ↔ target table columns
- **Data type coercion** — automatic type detection and conversion
- **Conflict resolution** — INSERT IGNORE, REPLACE, ON DUPLICATE KEY UPDATE
- **Dry-run mode** — validate without committing
- **Batch inserts** — configurable batch size (default: 1000 rows per INSERT)

---

### 3.6 Admin Service (Rust)

The Admin Service exposes MySQL server administration capabilities through the Tauri IPC interface.

#### Capabilities

| Category               | Operations                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **User Management**    | `CREATE USER`, `ALTER USER`, `DROP USER`, `GRANT`, `REVOKE`, `SHOW GRANTS`, password changes, account locking                                          |
| **Process Management** | `SHOW PROCESSLIST` (polling at configurable interval), `KILL <id>`, `KILL QUERY <id>`, filtering by user/database/state                                |
| **Server Variables**   | `SHOW [GLOBAL\|SESSION] VARIABLES`, `SET` for modifiable variables, search/filter, diff between global and session values                              |
| **Table Maintenance**  | `OPTIMIZE TABLE`, `REPAIR TABLE`, `ANALYZE TABLE`, `CHECK TABLE` — with multi-table batch support and progress tracking                                |
| **Backup**             | Native streaming SQL dump — no external binary; structure and/or data, views, routines and triggers, single-transaction snapshot, live progress        |
| **Server Metrics**     | `SHOW GLOBAL STATUS`, `SHOW ENGINE INNODB STATUS`, uptime, connections, query throughput, buffer pool usage — exposed as time-series for the dashboard |

#### Process Monitor Architecture

The diagram that stood here described a `start_process_monitor` command and a
`process_list_update` event pushed from a tokio background task. Neither was
ever built (#437), and describing them as though they were sent readers looking
for a command that does not exist.

What happens instead: the Process List tab calls `SHOW PROCESSLIST` on an
interval the user picks — off, 2s, 5s or 10s — and holds the result in
component state.

The load is smaller than it looks, which is why this is adequate rather than
merely tolerated. Admin is a tab in the editor, one per connection, and
`AdminPanel` renders only the tab in front of you: at most one process poller
runs at a time, regardless of how many connections are open or how many admin
tabs exist.

The backend push would buy two things this does not have — a shared poll
across several viewers of one connection, and a server-side interval that does
not drift with the renderer. Neither is a problem anybody has hit. If one is,
this is the design to build; until then it is a plan, and the section says so
rather than claiming it.

---

### 3.7 Frontend State Architecture (React / Zustand)

The frontend state is split into focused, independent Zustand stores. Each store owns a single domain and exposes actions that call Tauri IPC commands.

#### Store Map

```
src/stores/
├── connectionStore.ts    — Active connections, profiles, connection status
├── editorStore.ts        — Open tabs, editor content, cursor positions, dirty state
├── resultStore.ts        — Query results, pagination state, selected cells
├── favoritesStore.ts     — Saved queries, pinned favorites, folders
├── settingsStore.ts      — Query and formatter settings, update state
├── historyStore.ts       — Query history (a view over history.db)
├── schemaStore.ts        — Databases, tables, views, routines, triggers,
│                           events and columns, keyed by connection (§3.3)
└── themeStore.ts         — Active theme, custom themes, import/export
```

#### Store Design Pattern

Every store follows the same pattern:

```typescript
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

interface EditorTab {
  id: string;
  connectionId: string;
  title: string;
  content: string;
  cursorPosition: { line: number; column: number };
  isDirty: boolean;
  results: QueryResult | null;
}

interface EditorState {
  tabs: EditorTab[];
  activeTabId: string | null;

  // Actions
  openTab: (connectionId: string) => void;
  closeTab: (tabId: string) => void;
  setContent: (tabId: string, content: string) => void;
  executeCurrentTab: () => Promise<void>;
}

export const useEditorStore = create<EditorState>()(
  devtools(
    persist(
      (set, get) => ({
        tabs: [],
        activeTabId: null,

        openTab: (connectionId) => {
          const tab: EditorTab = {
            id: crypto.randomUUID(),
            connectionId,
            title: "Untitled",
            content: "",
            cursorPosition: { line: 1, column: 1 },
            isDirty: false,
            results: null,
          };
          set((state) => ({
            tabs: [...state.tabs, tab],
            activeTabId: tab.id,
          }));
        },

        executeCurrentTab: async () => {
          const { activeTabId, tabs } = get();
          const tab = tabs.find((t) => t.id === activeTabId);
          if (!tab) return;

          const result = await invoke<QueryResult>("execute_query", {
            connectionId: tab.connectionId,
            sql: tab.content,
          });

          set((state) => ({
            tabs: state.tabs.map((t) => t.id === activeTabId ? { ...t, results: result } : t),
          }));
        },
        // ... more actions
      }),
      { name: "editor-store" },
    ),
    { name: "EditorStore" },
  ),
);
```

#### Inter-Store Communication

Stores communicate through Zustand subscriptions and Tauri event listeners, not direct imports:

```
connectionStore ──(connect resolves)───────────────► schemaStore.loadSchema()
healthStore     ──(event: connection-health-event)─► status bar shows lost/retrying
schemaStore     ──(invalidate + re-read)───────────► autocomplete reads the same store
editorStore     ──(action: executeCurrentTab)───────► resultStore.setResults()
settingsStore   ──(subscription: theme changed)────► document.body.className update
```

---

## 4. Data Flow Diagrams

### 4.1 Query Execution Flow

```
┌──────────┐
│   User   │
└────┬─────┘
     │ Types SQL
     ▼
┌──────────────────┐
│   Monaco Editor   │  ← Syntax highlighting, autocomplete
└────────┬─────────┘
         │ Ctrl+Enter (or ⌘+Enter)
         ▼
┌──────────────────┐
│  editorStore      │  → Sets loading state, captures timestamp
│  .executeQuery()  │
└────────┬─────────┘
         │ invoke("execute_query", { connectionId, sql })
         ▼
┌──────────────────┐
│  Tauri IPC        │  ← JSON serialization
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  QueryExecutor    │  → Rust backend
│  ::execute()      │
└────────┬─────────┘
         │ sqlx::query(sql).fetch_all(&pool)
         ▼
┌──────────────────┐
│   MySQL Server    │
└────────┬─────────┘
         │ Result set (binary protocol)
         ▼
┌──────────────────┐
│  Serialize rows   │  → Vec<Vec<SqlValue>> + ColumnMeta
└────────┬─────────┘
         │ IPC response (JSON)
         ▼
┌──────────────────┐
│  resultStore      │  → Updates results, row count, timing
│  .setResults()    │
└────────┬─────────┘
         │ React re-render
         ▼
┌──────────────────┐
│  TanStack Table   │  ← Virtualized rendering (visible rows only)
└──────────────────┘
         │
         ▼
┌──────────────────┐
│  Status Bar       │  → "42 rows in 12ms" + warnings badge
└──────────────────┘
```

### 4.2 Large Result Sets

```
Frontend                         Rust Backend                    MySQL
   │                                 │                             │
   │ invoke("execute_query",         │                             │
   │        limit, offset)           │                             │
   │────────────────────────────────►│                             │
   │                                 │ raw_sql().fetch_many()      │
   │                                 │────────────────────────────►│
   │                                 │                             │
   │                                 │◄── rows, one at a time ─────│
   │                                 │  skip while offset not met  │
   │                                 │  keep until limit reached   │
   │                                 │  stop keeping, keep draining│
   │                                 │                             │
   │◄── QueryResult (≤ limit rows) ──│                             │
   │    rows_truncated: true         │                             │
```

The read is streamed; the _reply_ is not. What crosses the IPC boundary is
bounded by the row limit, so the renderer never receives more than it asked
for. "Next page" re-runs the statement with an offset.

#### On streaming

Earlier drafts specified `execute_query_stream` with `query_started`,
`query_rows` and `query_complete` events, and a frontend that assembled
batches as they arrived. It was never built, and the case it was for — a
million-row result overwhelming the renderer — is the case the row limit
exists to prevent. Streaming a million rows into a grid moves the problem
rather than solving it: the renderer still ends up holding them.

This is also what every comparable client does. DBeaver, TablePlus and Sequel
Ace all fetch a bounded page and offer a way to the next one; none streams
rows into the grid as they arrive.

Streaming would earn its keep for something the row limit cannot bound — an
export writing straight to a file, where the rows never need to be in memory
at once. The export path is where to build it, and §5.7 already describes that
shape. It is not needed for the grid.

#### On parameterized queries

`execute_query` takes SQL and no parameters. TESTING_STRATEGY listed a
`test_execute_with_params`, and the absence reads like a gap; it is not one.

The SQL reaching that command is the user's own text, typed into the editor.
There is no application-supplied value to bind — the whole statement is the
input. Adding a `params` array would add surface nothing calls.

Where values _are_ the app's, they are bound: every `information_schema` read
in `SchemaInspector` uses `sqlx::query().bind()`, and so does the admin
crate's. The remaining interpolation is of identifiers, which cannot be bound
in SQL at all and go through `schema::ident::quote_ident` instead.

Statements the app composes for the user to read — a backup file, a generated
`INSERT`, a DDL preview — cannot use placeholders either: the output is text,
and a `?` in a backup file is not a value. Those escape, and the escaping is
`lib/sql-quote.ts` and `backup-generator.ts`, both of which double the quote
so a value cannot end the string it is in.

### 4.3 Agent session flow

The inversion from ADR-011 in one diagram: the harness drives, SQLPilot answers
and polices. The flow that matters is not "user asks, model replies" — it is
what happens when the agent wants to change something.

```
┌──────────┐        ┌──────────────────┐        ┌─────────────────────┐
│   User   │───────►│  Their harness   │───────►│ SQLPilot MCP server │
└──────────┘  asks  │ (own credentials)│  tool  │   tools + policy    │
                    └──────────────────┘  call  └──────────┬──────────┘
                                                            │
                            ┌───────────────────────────────┤
                            │                               │
                    read or analyse                    write or DDL
                            │                               │
                            ▼                               ▼
                  ┌──────────────────┐         ┌────────────────────────┐
                  │ posture decides  │         │ 1. estimate_impact:    │
                  │ what comes back: │         │    run in a txn, count │
                  │ shape / samples  │         │    rows, ROLL BACK     │
                  │ / rows, redacted │         │ 2. SQLPilot's OWN      │
                  └────────┬─────────┘         │    confirmation, with  │
                           │                   │    the statement, the  │
                           │                   │    env badge, the count│
                           │                   │ 3. run, in a txn       │
                           │                   └───────────┬────────────┘
                           ▼                               ▼
                  ┌─────────────────────────────────────────────────┐
                  │ history, tagged with the session and the harness │
                  └─────────────────────────────────────────────────┘
```

Step 2 is not the harness's permission prompt. Harnesses have `--yolo`-shaped
flags; a guarantee that depends on the caller being polite is not one.

### 4.4 Connection Establishment Flow

```
┌──────────────────┐
│  User selects     │
│  saved profile    │
└────────┬─────────┘
         │ connectionStore.connect(profileId)
         ▼
┌──────────────────┐
│  invoke("connect" │  → { profileId }
│  )                │
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────────────────────┐
│  ConnectionManager::connect()                         │
│                                                       │
│  1. Load profile from ConnectionStore (rusqlite)      │
│  2. Retrieve password from OS keychain                │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │  If SSH configured:                              │ │
│  │                                                   │ │
│  │  SSHTunnel::establish()                          │ │
│  │    → ssh2::Session::connect(ssh_host:ssh_port)   │ │
│  │    → Authenticate (key or password)              │ │
│  │    → Forward local_port → db_host:db_port        │ │
│  │    → Rewrite connect URL: 127.0.0.1:local_port  │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  3. Build sqlx::MySqlConnectOptions                   │
│     → host, port, user, password                      │
│     → SSL mode + certificates (if configured)         │
│     → default database                                │
│                                                       │
│  4. sqlx::MySqlPool::connect_with(options)            │
│                                                       │
│  5. Health check: SELECT 1                            │
│                                                       │
│  6. Detect MySQL version: SELECT VERSION()            │
│                                                       │
│  7. ConnectionRegistry::insert(id, active_conn)       │
│                                                       │
│  8. SchemaInspector::introspect()                     │
│     → Load database list → cache                      │
│                                                       │
│  9. Start HealthChecker background task               │
└──────────────────┬───────────────────────────────────┘
                   │
                   ▼
┌──────────────────┐
│  Event:           │ ──► connectionStore updates
│  "connection_     │ ──► schemaStore loads tree
│   established"    │ ──► editorStore opens new tab
└──────────────────┘
```

---

## 5. IPC Interface Design

All communication between the frontend and backend occurs through Tauri's IPC commands (request/response) and events (push notifications). Commands are defined as `#[tauri::command]` functions in Rust and invoked from TypeScript via `@tauri-apps/api/core`.

### 5.1 Connection Commands

```rust
/// Establish a connection using a saved profile.
#[tauri::command]
async fn connect(
    profile_id: String,
    state: State<'_, AppState>,
) -> Result<ConnectionInfo, AppError>;

/// Disconnect and clean up resources (pool, SSH tunnel, health checker).
#[tauri::command]
async fn disconnect(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<(), AppError>;

/// Test a connection profile without persisting it.
#[tauri::command]
async fn test_connection(
    profile: ConnectionProfile,
    state: State<'_, AppState>,
) -> Result<TestResult, AppError>;

/// List all active (connected) sessions.
#[tauri::command]
async fn list_connections(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionInfo>, AppError>;

/// Persist a new or updated connection profile.
#[tauri::command]
async fn save_connection_profile(
    profile: ConnectionProfile,
    state: State<'_, AppState>,
) -> Result<String, AppError>;  // Returns profile ID

/// Delete a connection profile and its keychain entry.
#[tauri::command]
async fn delete_connection_profile(
    profile_id: String,
    state: State<'_, AppState>,
) -> Result<(), AppError>;
```

```rust
/// Every saved profile, without credentials.
///
/// The summary shape is deliberate: `ConnectionProfile`'s secret fields are
/// `#[serde(skip_serializing)]`, and a list command that returned the full
/// profile would be one `serde` attribute away from leaking every password.
#[tauri::command]
async fn list_connection_profiles(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionProfileSummary>, String>;

/// Whether an OS keyring answered at startup.
///
/// Not a capability probe run on demand — the answer is recorded once during
/// setup, because a keyring that is merely locked must not read as absent and
/// send the app down the "this profile has no password" path (#527).
#[tauri::command]
fn keyring_available() -> bool;
```

```rust
/// What the health checker last saw for a connection (§3.1). The checker
/// reports changes as `connection-health-event`; this is for a caller that
/// wants the state now — on mount, or after missing the events.
#[tauri::command]
async fn connection_health(connection_id: String) -> Result<Option<ConnectionHealth>, String>;

/// Check a connection now rather than waiting for the next scheduled ping.
#[tauri::command]
async fn ping_connection(connection_id: String) -> Result<ConnectionHealth, String>;

/// How full each live pool is, for the status bar (FR-1.2.3).
#[tauri::command]
async fn pool_stats() -> Result<Vec<PoolStats>, String>;

/// Anything that went wrong before the window existed — no saved
/// connections, no history, a data folder that will not persist. Empty is
/// the ordinary case. Nothing in startup panics: a process that vanishes
/// before a window exists tells the user nothing at all.
#[tauri::command]
async fn startup_problems() -> Result<Vec<StartupProblem>, String>;
```

### 5.2 Query Commands

```rust
/// Execute a SQL statement and return the full result.
#[tauri::command]
async fn execute_query(
    connection_id: String,
    sql: String,
    database: Option<String>,
    /// Rows to keep, and rows to skip before keeping any. There is no
    /// `params`: the SQL is the user's own text, so there is nothing for the
    /// app to bind (§4.2).
    limit: Option<u32>,
    offset: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<QueryResult>, QueryError>;

/// Cancel a running query by its handle.
#[tauri::command]
async fn cancel_query(
    query_id: String,
    state: State<'_, AppState>,
) -> Result<(), AppError>;

/// Plan a statement and return the plan.
///
/// `analyze` runs it — the decision to downgrade a write to a plain EXPLAIN
/// is made behind this boundary, not by the caller (#412). `format` picks the
/// shape: the tabular plan, the optimiser's JSON cost model, or MySQL's
/// iterator tree. The combinations a server does not have are resolved here
/// too: MariaDB has no FORMAT=TREE, and MySQL before 8.3 cannot combine
/// ANALYZE with JSON. Both come back as a plan plus a `format_fallback`
/// saying what was done instead, rather than as an error (#424).
#[tauri::command]
async fn explain_query(
    connection_id: String,
    sql: String,
    database: Option<String>,
    analyze: bool,
    format: Option<ExplainFormat>,
    state: State<'_, AppState>,
) -> Result<ExplainResponse, String>;

/// NOT IMPLEMENTED, and not planned. Formatting is the frontend's, via the
/// `sql-formatter` npm package driven by `FormatterSettings` — a round trip to
/// Rust to reformat the text the user is typing would buy nothing.
/// Format/beautify a SQL string.
#[tauri::command]
fn format_sql(sql: String) -> Result<String, AppError>;

/// NOT IMPLEMENTED. Planned; no such command is registered.
/// Retrieve query history entries with optional search.
#[tauri::command]
async fn get_query_history(
    connection_id: Option<String>,
    search: Option<String>,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<HistoryEntry>, AppError>;
```

```rust
/// Kill another connection's thread, from the process list.
///
/// Separate from `cancel_query`, which stops what *this* connection is
/// running. This one ends someone else's, so it is an admin action.
#[tauri::command]
async fn kill_query(
    state: State<'_, AppState>,
    connection_id: String,
    process_id: ProcessId,
) -> Result<(), String>;

/// The server thread ids this app owns on a connection.
///
/// The process list needs them to refuse to kill the user's own session, which
/// would otherwise disconnect them with no explanation.
#[tauri::command]
async fn get_own_thread_ids(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<ProcessId>, String>;
```

### 5.3 Schema Commands

```rust
/// List all databases on the connected server.
#[tauri::command]
async fn get_databases(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<Database>, AppError>;

/// List tables and views in a database.
#[tauri::command]
async fn get_tables(
    connection_id: String,
    database: String,
    state: State<'_, AppState>,
) -> Result<Vec<Table>, AppError>;

/// Get column details for a table.
#[tauri::command]
async fn get_columns(
    connection_id: String,
    database: String,
    table: String,
    state: State<'_, AppState>,
) -> Result<Vec<Column>, AppError>;

/// Get index details for a table.
#[tauri::command]
async fn get_indexes(
    connection_id: String,
    database: String,
    table: String,
    state: State<'_, AppState>,
) -> Result<Vec<Index>, AppError>;

/// Get foreign key relationships for a table.
#[tauri::command]
async fn get_foreign_keys(
    connection_id: String,
    database: String,
    table: String,
    state: State<'_, AppState>,
) -> Result<Vec<ForeignKey>, AppError>;

/// Get the CREATE TABLE DDL for a table.
#[tauri::command]
async fn get_table_ddl(
    connection_id: String,
    database: String,
    table: String,
    state: State<'_, AppState>,
) -> Result<String, AppError>;

/// Get triggers defined on a table.
#[tauri::command]
async fn get_triggers(
    connection_id: String,
    database: String,
    table: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<Trigger>, AppError>;

/// Scheduled events for a database. FR-4.1.1 lists them beside the other
/// object types, and there was no query for them at all (#291).
#[tauri::command]
async fn get_events(
    connection_id: String,
    database: String,
) -> Result<Vec<EventInfo>, String>;

/// A table's partitions, for the details panel (FR-4.2.1). Empty for an
/// unpartitioned table, which is not an error (#292).
#[tauri::command]
async fn get_partitions(
    connection_id: String,
    database: String,
    table: String,
) -> Result<Vec<PartitionInfo>, String>;

/// Get stored procedures and functions.
#[tauri::command]
async fn get_routines(
    connection_id: String,
    database: String,
    state: State<'_, AppState>,
) -> Result<Vec<Routine>, AppError>;

/// NOT IMPLEMENTED. Planned; no such command is registered.
/// Force-refresh the schema cache for a database.
#[tauri::command]
async fn refresh_schema(
    connection_id: String,
    database: String,
    state: State<'_, AppState>,
) -> Result<(), AppError>;
```

```rust
/// Views in a database, listed separately from tables because the tree shows
/// them separately and a view has no row count worth fetching.
#[tauri::command]
async fn get_views(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<Vec<ViewInfo>, String>;

/// `SHOW CREATE` for the objects that have one. Three commands rather than one
/// with a kind parameter, because the underlying statement differs per object
/// type and a single entry point would only branch on the parameter anyway.
#[tauri::command]
async fn get_view_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    view_name: String,
) -> Result<String, String>;

#[tauri::command]
async fn get_routine_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    routine_name: String,
    /// "PROCEDURE" or "FUNCTION".
    routine_type: String,
) -> Result<String, String>;

#[tauri::command]
async fn get_trigger_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    trigger_name: String,
) -> Result<String, String>;
```

### 5.4 AI Commands — none

There are none, and this is not an omission. ADR-011 made SQLPilot an MCP
server rather than a model client: the commands that used to be here
(`ai_chat`, `ai_get_status`, `ai_set_config`, `ai_cancel`,
`ai_approve_permission`) are gone with the `mas-ai` crate, along with the
`beta-ai` feature that gated them and the three more this section described
that were never written at all.

What replaces them is not a command surface but a **tool** surface, spoken to
over MCP by the user's own harness, plus the small set of app-side commands
that start the server and export its configuration. Those are designed in
[AI_INTEGRATION.md](AI_INTEGRATION.md) and will be documented here as §5.12
when they exist.

### 5.5 Export / Import Commands

Import and export are built from small, general commands rather than one
command per feature. The backend picks files, reads and writes them, and
formats a result set; what to do with the contents is the frontend's
decision, and running SQL goes through `execute_query` like everything else.

This section previously declared `export_data`, `import_data` and
`preview_import`. None of them were ever implemented (#363).

```rust
/// Format an already-fetched result set as CSV, JSON, SQL INSERTs or
/// Markdown. Returns the text; writing it is a separate step.
#[tauri::command]
async fn export_results(
    result: QueryResult,
    format: String,
    table_name: Option<String>,
) -> Result<String, String>;

/// Native open dialog. `filters` is (label, extensions).
#[tauri::command]
async fn pick_file(
    title: String,
    filters: Vec<(String, Vec<String>)>,
) -> Result<Option<String>, String>;

/// Native save dialog.
#[tauri::command]
async fn pick_save_file(
    title: String,
    default_name: String,
    filters: Vec<(String, Vec<String>)>,
) -> Result<Option<String>, String>;

/// Read a whole file. Refuses anything over 256 MB: the contents are held as
/// a Rust string, a JavaScript string and parsed rows at the same time, so a
/// larger file takes the renderer down before the user sees it (#366).
#[tauri::command]
async fn read_file_contents(path: String) -> Result<String, String>;

/// Write a whole file.
#[tauri::command]
async fn write_file_contents(path: String, contents: String) -> Result<(), String>;
```

**Import.** A CSV is parsed in the renderer (`csv-parser.ts`) and inserted in
batches through `execute_query`. A SQL file is not: it goes to
`restore_database` (§5.11), which reads it in chunks, splits it in Rust and
runs it on one connection — the same path the restore dialog uses. The
renderer reads only the first 512 KB of it, to preview it and to name what it
will drop.

There is a transaction around a SQL import, and it makes a data-only file all
or nothing. It cannot make a dump with DDL atomic: `CREATE`, `DROP` and
`ALTER` each commit before they run. The import stops at the first error by
default and says whether what had already run stands (#365).

**Preview** is frontend-side too: the file is already in memory, so a
dedicated command would re-read it to answer a question the renderer can
answer for free.

**Streaming.** The SQL paths — import, restore and backup — stream: the file
is read and written in chunks by the backend and never held whole. The CSV
import still parses in the renderer, so `read_file_contents`'s size limit is
what bounds it.

### 5.6 History Commands

Query history lives in `history.db` rather than the renderer's `localStorage`,
so every read and write crosses the IPC boundary (#585). See §9.4.

```rust
/// Record one executed statement, then trim to `limit`.
///
/// The limit is passed per call rather than held as backend state: it is a UI
/// preference, and two sources of truth for it would drift.
#[tauri::command]
async fn history_add(
    state: State<'_, AppState>,
    entry: HistoryEntry,
    limit: u32,
) -> Result<HistoryEntry, String>;

/// Read a filtered, sorted page. Filtering is a WHERE clause rather than an
/// array scan, which is most of why history moved to SQLite (#589).
#[tauri::command]
async fn history_list(
    state: State<'_, AppState>,
    query: HistoryQuery,
) -> Result<Vec<HistoryEntry>, String>;

/// How many the same filter matches, ignoring its page size — so the panel can
/// say "50 of 812" rather than leaving a full page and a last page identical.
#[tauri::command]
async fn history_count_matching(
    state: State<'_, AppState>,
    query: HistoryQuery,
) -> Result<u32, String>;

/// The connections, databases and origins that appear in the history, so the
/// filter offers only values that would return something.
#[tauri::command]
async fn history_facets(state: State<'_, AppState>) -> Result<HistoryFacets, String>;

/// Render everything the filter matches as CSV or SQL — all of it, not the
/// page on screen.
#[tauri::command]
async fn history_export(
    state: State<'_, AppState>,
    query: HistoryQuery,
    format: HistoryExportFormat,
) -> Result<String, String>;

#[tauri::command]
async fn history_remove(state: State<'_, AppState>, id: String) -> Result<(), String>;

#[tauri::command]
async fn history_clear(state: State<'_, AppState>) -> Result<(), String>;

#[tauri::command]
async fn history_count(state: State<'_, AppState>) -> Result<u32, String>;

/// Apply a lowered count limit straight away, rather than waiting for the next
/// query to trim.
#[tauri::command]
async fn history_prune(state: State<'_, AppState>, limit: u32) -> Result<u32, String>;

/// Apply the retention period. Run at startup rather than on a timer, so a
/// long-lived session does not delete rows under the user (#592).
#[tauri::command]
async fn history_prune_older_than(
    state: State<'_, AppState>,
    cutoff: String,
) -> Result<u32, String>;

/// Take over a history still held in localStorage. Ids carry across, so
/// running it twice imports nothing the second time.
#[tauri::command]
async fn history_import(
    state: State<'_, AppState>,
    entries: Vec<HistoryEntry>,
    limit: u32,
) -> Result<u32, String>;
```

### 5.7 SQLite Commands

A second backend behind the same shared pane (#461). SQLite has no server, no
users and no databases to switch between, so it registers its own commands
rather than pretending to answer the MySQL ones — `datasource.ts` is what makes
the two look alike to the UI.

```rust
/// Open a file and return a connection id. `:memory:` is accepted.
#[tauri::command]
async fn sqlite_open(state: State<'_, AppState>, path: String) -> Result<String, String>;

#[tauri::command]
async fn sqlite_close(state: State<'_, AppState>, connection_id: String) -> Result<(), String>;

#[tauri::command]
async fn sqlite_list(state: State<'_, AppState>) -> Result<Vec<String>, String>;

/// Fails with the same `QueryError` as the MySQL path, carrying SQLite's
/// extended result code where MySQL would carry its error number (#324).
#[tauri::command]
async fn sqlite_execute(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> Result<Vec<SqliteQueryResult>, QueryError>;

#[tauri::command]
async fn sqlite_get_tables(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<SqliteTableInfo>, String>;

#[tauri::command]
async fn sqlite_get_columns(
    state: State<'_, AppState>,
    connection_id: String,
    table: String,
) -> Result<Vec<SqliteColumnInfo>, String>;

#[tauri::command]
async fn sqlite_get_indexes(
    state: State<'_, AppState>,
    connection_id: String,
    table: String,
) -> Result<Vec<SqliteIndexInfo>, String>;

#[tauri::command]
async fn sqlite_get_table_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    table: String,
) -> Result<String, String>;
```

### 5.8 Platform Commands

```rust
/// How this build was installed, and for which architecture.
///
/// The updater needs it: an in-app update must not run against a Flatpak,
/// Snap or rpm-ostree install, where the package manager owns the binary
/// (#343). Probed rather than compiled in, because one Linux binary can be
/// shipped through several of them.
#[tauri::command]
async fn get_platform_info() -> Result<PlatformInfo, String>;
```

### 5.9 Admin Commands

```rust
/// Get the MySQL process list.
#[tauri::command]
async fn get_process_list(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<Process>, AppError>;

/// Kill a MySQL process/query.
#[tauri::command]
async fn kill_process(
    connection_id: String,
    process_id: u64,
    kill_query_only: Option<bool>,
    state: State<'_, AppState>,
) -> Result<(), AppError>;

/// Get server variables (global and/or session).
#[tauri::command]
async fn get_server_variables(
    connection_id: String,
    scope: Option<VariableScope>,  // Global | Session | Both
    filter: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<Variable>, AppError>;

/// NOT IMPLEMENTED. Planned; no such command is registered.
/// Get user accounts and their privileges.
#[tauri::command]
async fn get_users(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<User>, AppError>;

/// NOT IMPLEMENTED. Planned; no such command is registered.
/// Get server status metrics for dashboard display.
#[tauri::command]
async fn get_server_status(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<ServerStatus, AppError>;

/// NOT IMPLEMENTED. Planned; no such command is registered.
/// Run table maintenance operations.
#[tauri::command]
async fn table_maintenance(
    connection_id: String,
    database: String,
    tables: Vec<String>,
    operation: MaintenanceOp,  // Optimize | Repair | Analyze | Check
    state: State<'_, AppState>,
) -> Result<Vec<MaintenanceResult>, AppError>;
```

### 5.10 Tauri Events (Backend → Frontend)

Five events exist. The table below used to list nine, of which six described a
streaming architecture that was never built (#284) and progress channels for an
export and an import that are both done in the renderer (§5.5).

| Event Name                | Payload                       | Description                                                                       |
| ------------------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| `connection-health-event` | `ConnectionHealth`            | A connection stopped answering, or started again (§3.1). Every attempt while down |
| `backup-progress-event`   | `BackupProgressEvent`         | Where a running backup has got to: table, rows, bytes, rows/sec (§5.11)           |
| `restore-progress-event`  | `RestoreProgressEvent`        | Where a running restore or SQL import has got to: bytes read, statements run      |
| `ai:event`                | `AiStreamEvent`               | Streamed AI response, behind the `beta-ai` feature                                |
| `menu-action`             | `String` (the menu item's id) | A native menu item was chosen                                                     |

The first three are generated by `tauri-specta` from their Rust types, so the
listener's payload type and the emitted struct cannot drift. The other two are
emitted by name with a hand-written type on the frontend.

### 5.11 Backup Commands

A backup is written by the backend, straight to the file, as it reads. The
whole dump used to be built in the renderer as one JavaScript string and
handed across IPC at the end, which held gigabytes in the WebView for a large
table and read rows with `LIMIT/OFFSET` against the pool — quadratic, and with
no ORDER BY and no shared session, free to repeat a row or skip one (#358).

```rust
/// Dump a database to `output_path`, streaming. Resolves when the file is
/// complete. Progress arrives as `backup-progress-event`.
#[tauri::command]
async fn backup_database(
    backup_id: String,
    connection_id: String,
    database: String,
    tables: Vec<String>,
    options: BackupOptions,
    output_path: String,
) -> Result<BackupSummary, String>;

/// Ask a running backup to stop. Returns whether there was one.
#[tauri::command]
async fn cancel_backup(backup_id: String) -> Result<bool, String>;

/// The defaults the dialog starts from.
#[tauri::command]
async fn default_backup_options() -> Result<BackupOptions, String>;

/// Run a SQL file into a database, streaming it. Used by both the restore
/// dialog and the SQL half of the import dialog — they are the same
/// operation, and were two implementations of it (§5.5). Progress arrives as
/// `restore-progress-event`; `cancel_backup` stops it.
#[tauri::command]
async fn restore_database(
    restore_id: String,
    connection_id: String,
    database: String,
    input_path: String,
    options: RestoreOptions,
) -> Result<RestoreSummary, String>;

/// The defaults the restore dialog starts from.
#[tauri::command]
async fn default_restore_options() -> Result<RestoreOptions, String>;

/// The first `max_bytes` of a file, with the whole file's size. For a
/// preview: `read_file_contents` would read a multi-gigabyte dump into the
/// renderer to draw thirty lines.
#[tauri::command]
async fn read_file_head(path: String, max_bytes: u32) -> Result<FileHead, String>;
```

**No external binary.** There is no `mysqldump` wrapper and no probe for one.
The dump is `mas-core::backup`, which reads over MySQL's text protocol and
formats each value from the bytes the server printed — so a `DECIMAL` keeps
its digits, a `DATETIME(6)` keeps its microseconds, and a `BIGINT` is not
rounded through a float. Requiring a binary that a desktop user may not have,
whose version may not match the server, would be a worse guarantee than that,
not a better one.

**Consistency.** With `consistent_snapshot` (the default) the reads happen
inside `START TRANSACTION WITH CONSISTENT SNAPSHOT` on one pooled connection,
which is what `mysqldump --single-transaction` does. Without it a dump of a
live database can contain a child row whose parent was written later and is
not in the file. When the server refuses — MyISAM — the dump says so, in the
file and in `BackupSummary::warnings`.

**Cancelling removes the file.** A partial dump that looks like a dump is how
someone restores half a database a month later.

## 6. Security Architecture

### 6.1 Credential Storage

```
┌────────────────────────────────────────────────────────┐
│                  Credential Flow                        │
│                                                         │
│  User enters password                                   │
│         │                                               │
│         ▼                                               │
│  Frontend: invoke("save_connection_profile", {          │
│    ...profile,                                          │
│    password: "••••••"    ← Only time plaintext crosses  │
│  })                         IPC; immediately consumed   │
│         │                                               │
│         ▼                                               │
│  Rust: keyring::Entry::new("sqlpilot", id)      │
│        .set_password(plaintext)                         │
│         │                                               │
│         ▼                                               │
│  ┌─────────────────────────────────────────────┐       │
│  │         OS Keychain / Secret Service          │       │
│  │                                               │       │
│  │  Windows: Credential Manager                  │       │
│  │  macOS:   Keychain (login keychain)           │       │
│  │  Linux:   Secret Service API (GNOME Keyring   │       │
│  │           or KWallet via D-Bus)               │       │
│  └─────────────────────────────────────────────┘       │
│                                                         │
│  ConnectionProfile stores only a PasswordRef:           │
│    { keychain_service: "sqlpilot",               │
│      keychain_account: "<profile_id>" }                 │
│                                                         │
│  Password is retrieved at connect() time and held       │
│  only in memory for the duration of pool creation.      │
└────────────────────────────────────────────────────────┘
```

### 6.2 Tauri Security Model

| Layer                       | Configuration                                                                                                                                                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Command Allowlist**       | Only explicitly registered `#[tauri::command]` functions are callable from the frontend. No filesystem, shell, or HTTP access is granted by default.                                                                                                                                         |
| **Content Security Policy** | `default-src 'self'; script-src 'self' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src ipc: http://ipc.localhost http://localhost:* http://127.0.0.1:*` — blocks external resource loading while allowing Monaco workers and local dev endpoints |
| **IPC Origin Check**        | Tauri validates that IPC messages originate from the app's webview, not injected scripts                                                                                                                                                                                                     |
| **Permission Scopes**       | Tauri 2's granular permissions restrict each plugin/command to minimum required capabilities                                                                                                                                                                                                 |
| **No Remote Content**       | The frontend is bundled locally; no remote URLs are loaded in the webview                                                                                                                                                                                                                    |

### 6.3 Network Security

| Scenario              | Protection                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| **Direct Connection** | Optional SSL/TLS (`ssl-mode=REQUIRED` or `VERIFY_IDENTITY`) with custom CA certificate support |
| **SSH Tunnel**        | All MySQL traffic encrypted through SSH tunnel; supports Ed25519, RSA, and ECDSA keys          |
| **Cloud Databases**   | Enforced SSL for RDS, PlanetScale, etc.; certificate bundles included or user-provided         |
| **AI API Calls**      | HTTPS only; OAuth tokens stored in OS keychain; no query data logged server-side               |

### 6.4 Destructive Operation Safeguards

```
User attempts: DROP TABLE customers;
         │
         ▼
  Frontend detects DDL keyword pattern
         │
         ▼
  ┌─────────────────────────────────────────────┐
  │  Confirmation Dialog                         │
  │                                              │
  │  ⚠️  You are about to execute a destructive  │
  │  operation:                                  │
  │                                              │
  │    DROP TABLE customers                      │
  │                                              │
  │  This will permanently delete the table      │
  │  and all its data.                           │
  │                                              │
  │  Type "customers" to confirm:                │
  │  ┌──────────────────────────┐               │
  │  │                          │               │
  │  └──────────────────────────┘               │
  │                                              │
  │       [Cancel]  [Execute]                    │
  └─────────────────────────────────────────────┘
         │
         ▼ (if confirmed)
  Audit log entry: { timestamp, user, sql, connection }
         │
         ▼
  Execute via QueryExecutor
```

### 6.5 Security Checklist

- [x] Passwords stored in OS keychain, never in config files or SQLite
- [x] No secrets in IPC messages after initial storage (use handle references)
- [x] CSP headers block external script/resource loading
- [x] Tauri command allowlist limits exposed backend API surface
- [x] SSH key passphrases retrieved from keychain, not stored in profile
- [x] Audit logging for all DDL and admin operations
- [x] Read-only mode per connection to prevent accidental writes
- [x] Local SQLite databases use WAL mode (prevents corruption on crash)
- [x] Log files exclude query parameters and credentials (redaction filters)

---

## 7. Error Handling Strategy

### 7.1 Rust Error Hierarchy

```rust
/// Top-level application error returned through IPC.
#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "type", content = "detail")]
pub enum AppError {
    #[error("Connection error: {message}")]
    Connection {
        message: String,
        code: Option<String>,       // e.g., "ER_ACCESS_DENIED_ERROR"
        recoverable: bool,
    },

    #[error("Query error: {message}")]
    Query {
        message: String,
        code: Option<String>,       // MySQL error code
        line: Option<u32>,          // Line number in SQL
        column: Option<u32>,        // Column position
    },

    #[error("Authentication error: {message}")]
    Auth {
        message: String,
    },

    #[error("SSH tunnel error: {message}")]
    SSH {
        message: String,
        cause: Option<String>,
    },

    #[error("Export error: {message}")]
    Export {
        message: String,
        rows_completed: Option<u64>,
    },

    #[error("Import error: {message}")]
    Import {
        message: String,
        row_number: Option<u64>,
        column_name: Option<String>,
    },

    #[error("AI service error: {message}")]
    AI {
        message: String,
        provider: Option<String>,
        retryable: bool,
    },

    #[error("Schema error: {message}")]
    Schema {
        message: String,
    },

    #[error("Configuration error: {message}")]
    Config {
        message: String,
    },

    #[error("Internal error: {message}")]
    Internal {
        message: String,
    },
}
```

### 7.2 Error Context Chain

Errors are enriched with context using `anyhow` before being converted to `AppError`:

```rust
// In the connection manager:
let pool = MySqlPool::connect_with(options)
    .await
    .context("Failed to establish MySQL connection")
    .context(format!("Profile: {} ({}:{})", profile.name, profile.host, profile.port))
    .map_err(|e| AppError::Connection {
        message: format!("{:#}", e),  // Full context chain
        code: extract_mysql_error_code(&e),
        recoverable: is_recoverable(&e),
    })?;
```

### 7.3 Frontend Error Handling

| Error Location           | Handling Strategy                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **React Error Boundary** | Wraps each major panel (editor, results, schema tree). Catches render crashes and shows a "Something went wrong" fallback with a retry button.                              |
| **IPC Errors**           | Caught in store actions; parsed into typed errors; displayed as toast notifications with appropriate severity (info/warning/error).                                         |
| **Query Errors**         | Displayed inline in the results panel. If the error includes `line`/`column`, the corresponding position is highlighted in the Monaco editor with a red squiggly underline. |
| **Connection Errors**    | Trigger a reconnection dialog with options: Retry Now, Retry with Different Credentials, Cancel. Auto-reconnect attempts run in the background.                             |
| **AI Errors**            | Non-blocking; shown as a message in the AI chat panel. The application remains fully functional without AI.                                                                 |
| **Export/Import Errors** | Displayed in the progress dialog. Partial exports are preserved (user can resume or discard).                                                                               |

### 7.4 Graceful Degradation

What the app does without each of the things it would rather have. The rule
behind all of it: **nothing in startup panics.** A process that dies before a
window exists leaves a message in a terminal the desktop user does not have
open, so every failure below degrades to something the app can report from
inside itself (#278 was this shape, for the keyring).

| What is missing            | What happens                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **OS keyring**             | Passwords are kept for the session only; the status bar says so. A locked keyring never counts as "this profile has no password" (#274)  |
| **The data directory**     | Falls back to a temp directory, then to the working directory. The status bar says settings may not survive a restart                    |
| **The log directory**      | Console logging only                                                                                                                     |
| **`connections.db`**       | Starts with an in-memory store: no saved profiles, and the file is left untouched so whatever is wrong with it can still be recovered    |
| **`history.db`**           | Starts with an in-memory store: this session's history is not kept, everything else works. History lives in its own file for this reason |
| **SSH tunnelling**         | Not implemented. A profile configured for one is **refused** — connecting direct while the UI implies a tunnel is worse (#273)           |
| **An AI provider**         | The panel says to configure one; everything else works. The whole feature is behind the `beta-ai` flag                                   |
| **A server that has gone** | The health checker marks it and keeps trying (§3.1); sqlx reopens a pooled connection when one is next needed                            |

Each startup failure becomes a `StartupProblem` — a kind, a summary in the
user's terms, and the underlying error for a bug report — read once by the
status bar through `startup_problems` (§5.1).

---

## 8. Performance Optimization Strategies

### 8.1 Backend Optimizations

| Strategy               | Implementation                                                                                               | Impact                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| **Connection Pooling** | `sqlx::MySqlPool` with configurable min/max connections (default: 1–5 per profile)                           | Eliminates connection setup overhead for repeated queries       |
| **Schema Caching**     | In-memory `HashMap` with TTL per object type; invalidated on DDL detection                                   | Reduces INFORMATION_SCHEMA queries from seconds to microseconds |
| **Bounded results**    | Rows read one at a time and kept up to the configured limit; the rest of the stream is drained but discarded | The renderer holds at most one page, whatever the result size   |
| **Binary Protocol**    | `sqlx` uses MySQL's binary protocol by default for prepared statements                                       | 2–5× less bandwidth than text protocol for numeric types        |
| **Query Pagination**   | Rust adds `LIMIT` / `OFFSET` for table browsing; frontend requests pages on demand                           | Only transfers visible data                                     |
| **Async I/O**          | Every database, file, and network operation is non-blocking via Tokio                                        | Main thread and UI thread are never blocked                     |
| **SSH Tunnel Reuse**   | One tunnel per SSH host; multiple MySQL connections share the same tunnel                                    | Avoids SSH handshake per connection                             |

### 8.2 Frontend Optimizations

| Strategy                   | Implementation                                                           | Impact                                             |
| -------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| **Row Virtualization**     | TanStack Virtual renders only visible rows (~30–50 at a time)            | Handles 1M+ rows without DOM bloat                 |
| **Column Virtualization**  | Only visible columns are rendered; horizontal scroll triggers re-render  | Wide tables (100+ columns) remain performant       |
| **Lazy Schema Tree**       | Databases load on connect; tables load on expand; columns load on expand | Fast initial load even with hundreds of databases  |
| **Debounced Autocomplete** | Monaco completions fire after 150ms of idle typing                       | Prevents API spam during fast typing               |
| **Web Worker for Monaco**  | Syntax highlighting and validation run in a Web Worker                   | Keeps the UI thread responsive during editing      |
| **Memoized Components**    | `React.memo` on table cells, tree nodes, and tab headers                 | Prevents unnecessary re-renders in hot paths       |
| **Zustand Selectors**      | Fine-grained subscriptions (`useStore(s => s.field)`)                    | Components re-render only when their slice changes |
| **Persisted Panel Layout** | Panel sizes saved to localStorage; restored on launch                    | No layout recalculation on startup                 |

### 8.3 Performance Budgets

| Metric                      | Target      | Measurement                             |
| --------------------------- | ----------- | --------------------------------------- |
| App launch to interactive   | < 2 seconds | Tauri window open + React hydration     |
| Connection establishment    | < 3 seconds | Profile select to schema tree populated |
| Simple query (100 rows)     | < 200ms     | Ctrl+Enter to results rendered          |
| Large query (100K rows)     | < 5 seconds | First batch visible in < 500ms          |
| Schema tree expand          | < 300ms     | Click to children visible               |
| Autocomplete popup          | < 200ms     | Keystroke to suggestions visible        |
| Memory (idle, 1 connection) | < 150 MB    | Measured via OS task manager            |
| Binary size (installed)     | < 30 MB     | Platform-specific installer             |

---

## 9. Local Storage Architecture

Two-tier storage: filesystem (`connections.db` + `history.db` + logs + keyring) on the Rust side, and `localStorage` for the small UI preferences that are cheap to lose.

### Directory Structure (filesystem / Rust)

```
~/.local/share/sqlpilot/                (Linux: $XDG_DATA_HOME/sqlpilot)
|                                        (macOS: ~/Library/Application Support/sqlpilot/)
|                                        (Windows: %APPDATA%/sqlpilot/)
|
|-- connections.db                       -- SQLite: connection profiles
|                                          (passwords are NOT here; see "Password
|                                          storage" below)
|-- connections.db-wal                   -- SQLite write-ahead-log (auto)
|-- connections.db-shm                   -- SQLite shared-memory file (auto)
|
|-- history.db                           -- SQLite: query history (#585)
|                                          (separate file so an append-only log
|                                          that grows without bound cannot take
|                                          the connection profiles with it)
|-- history.db-wal                       -- SQLite write-ahead-log (auto)
|-- history.db-shm                       -- SQLite shared-memory file (auto)
|
\-- logs/                                -- Structured log files (tracing-subscriber)
    |-- sqlpilot.log.YYYY-MM-DD          -- Current day, rolling
    \-- sqlpilot.log.YYYY-MM-DD.1       -- Yesterday, gzipped
```

`themes/`, `snippets/`, `backups/`, `cache/` from earlier drafts were never implemented. Themes live in localStorage rather than as files on disk: `theme` holds the id of the one in use, and `sqlpilot.custom-themes` holds any the user imported or made. The built-in palettes are in `src/lib/themes.ts`, and import/export is a file the user chooses rather than a directory the app scans (#350). Snippets/favorites are stored via the `favoritesStore`; query history via the `historyStore`. Schema metadata is fetched live via `mas-core::schema::SchemaInspector` and cached in memory for the session only (re-fetched on connection-change / manual refresh); AI response cache is in-memory keyed by prompt hash (no on-disk cache).

### localStorage keys (frontend / Zustand)

| Key                           | Owner                          | Format                                         |
| ----------------------------- | ------------------------------ | ---------------------------------------------- |
| `theme`                       | `themeStore.ts`                | single string: a theme id, or `"system"`       |
| `sqlpilot.custom-themes`      | `themeStore.ts`                | JSON: `Theme[]`, re-validated on read (#350)   |
| `sqlpilot-formatter-settings` | `settingsStore.ts`             | JSON: full `FormatterSettings`                 |
| `sqlpilot-query-settings`     | `settingsStore.ts`             | JSON: `{ maxResultRows, limitEnabled }`        |
| `sqlpilot-history-limit`      | `historyStore.ts`              | single number: the retention count (#585)      |
| `mas-query-favorites`         | `favoritesStore.ts`            | JSON via `zustand/middleware::persist`         |
| `sqlpilot-editor-session`     | `editorStore.ts` (manual save) | JSON: `{ tabs, activeTabId }` debounced ~150ms |

The webview's localStorage lives under `~/Library/Application Support/com.sqlpilot.app/...` (macOS), `~/.config/com.sqlpilot.app/...` (Linux), `%APPDATA%\com.sqlpilot.app\...` (Windows) — separate from the data dir above. Bundle identifier is set via `tauri.conf.json:identifier = "com.sqlpilot.app"`.

### Password storage

Passwords are never written to disk. The schema column `password TEXT NOT NULL DEFAULT ''` is emptied once the password is migrated to the OS-native keyring (macOS Keychain, Linux Secret Service / KWallet via D-Bus, Windows Credential Manager) via `apple-native-keyring-store` (`src-tauri/Cargo.toml:43`). On startup, `migrate_plaintext_passwords` moves any non-empty plaintext values into the keyring and clears the column. After migration, the SQL row holds an empty `password` string; the actual secret lives in the OS keyring keyed by `connection_profiles.id`. The Rust side resolves it via `keyring-core` (see `src-tauri/crates/mas-core/src/connection/store.rs:287-367`).

### SQLite Schema: `connections.db`

One table. Schema is created idempotently in `ConnectionStore::init_tables()` (`src-tauri/crates/mas-core/src/connection/store.rs:25`) via `CREATE TABLE IF NOT EXISTS` followed by `ALTER TABLE ... .ok()` migration stanzas (each column added in a separate migration call). The `.ok()` swallows errors — a silent failure mode that needs replacing with a `PRAGMA user_version`-gated framework (tracked in #241).

```sql
CREATE TABLE IF NOT EXISTS connection_profiles (
    id                     TEXT PRIMARY KEY,
    name                   TEXT NOT NULL,
    grp                    TEXT,
    color                  TEXT,
    host                   TEXT NOT NULL,
    port                   INTEGER NOT NULL DEFAULT 3306,
    username               TEXT NOT NULL,
    password               TEXT NOT NULL DEFAULT '',   -- emptied after keyring migration
    default_database       TEXT,
    ssh_config             TEXT,                         -- JSON blob (SshConfig)
    ssl_config             TEXT,                         -- JSON blob (SslConfig)
    pool_min               INTEGER NOT NULL DEFAULT 1,
    pool_max               INTEGER NOT NULL DEFAULT 5,
    read_only              INTEGER NOT NULL DEFAULT 0,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    env                    TEXT,                         -- 'production' | 'staging' | 'development'
    connect_timeout_secs   INTEGER,
    query_timeout_secs     INTEGER,
    charset                TEXT
);
```

Migration chain (each `.ok()` swallows failures — silent failure mode that needs replacing with a version-gated framework, see #241):

| Migration | Column                         | Origin                          |
| --------- | ------------------------------ | ------------------------------- |
| initial   | all columns up to `updated_at` | first migration                 |
| v0.2.x    | `env` TEXT                     | env badge on Profile tab        |
| v0.3.x    | `connect_timeout_secs` INTEGER | connection-level timeout        |
| v0.3.x    | `query_timeout_secs` INTEGER   | per-query timeout               |
| v0.3.x    | `charset` TEXT                 | per-connection charset override |

No `password_ref` column (passwords live in OS keyring, not SQL). No `sort_order` column (ordering derived from `updated_at` at read time). No `pool_config` JSON blob (pool settings are two separate columns `pool_min` / `pool_max`).

### Query history — in SQLite; favorites — not

The `query_history` table from earlier drafts went unimplemented for a long time and history lived in `localStorage` instead. It is implemented now (#585). Today:

- `historyStore.ts` — a view over `history.db`, a SQLite database beside `connections.db` with its own `PRAGMA user_version` migrations (`mas_core::history`). Its own file rather than a table in `connections.db`: history is append-only and much larger, and a corrupt or oversized history should not be able to take the connection profiles down with it. Keeps the last `limit` queries, default 500, changed from the history panel. Search is a `LIKE` with an explicit `ESCAPE`, not an array scan. A statement over `MAX_SQL_BYTES` (256 KB) is stored cut and marked `truncated`. On first run the old `mas-query-history` localStorage key is imported and then removed; ids carry across, so an interrupted handover resumes rather than duplicating. Every statement the app sends is recorded and tagged with its origin (`editor`, `grid`, `designer`, `routine`, `admin`, `import`, `restore`, `internal`) by `lib/run-statement.ts`, which is the single door in; the panel shows the user-facing origins by default and widens on request (#586).
- `favoritesStore.ts` — saved queries + categories, `localStorage` via `persist` keyed `mas-query-favorites`.

A future migration to SQLite (`history.db`) is plausible but not in scope.

---

## 10. Plugin Architecture (Future)

> **Status:** Planned for v2.0. This section describes the intended design; implementation details may change.

### 10.1 Overview

SQLPilot will support a plugin system that allows third-party developers to extend both the backend (Rust) and frontend (React) of the application.

```
┌─────────────────────────────────────────────────────────┐
│                    Plugin Host                           │
│                                                          │
│  ┌──────────────────┐   ┌─────────────────────────────┐ │
│  │  Plugin Registry  │   │     Event Bus                │ │
│  │                    │   │                             │ │
│  │  • Load manifests │   │  • Plugin ↔ Core events     │ │
│  │  • Version check  │   │  • Plugin ↔ Plugin events   │ │
│  │  • Dependency     │   │  • Namespaced channels      │ │
│  │    resolution     │   │                             │ │
│  └──────────────────┘   └─────────────────────────────┘ │
│                                                          │
│  ┌──────────────────┐   ┌─────────────────────────────┐ │
│  │  Backend Plugins  │   │   Frontend Plugins           │ │
│  │  (Tauri Plugins)  │   │   (React Components)        │ │
│  │                    │   │                             │ │
│  │  • New IPC cmds   │   │  • Sidebar panels           │ │
│  │  • Custom drivers │   │  • Result view tabs         │ │
│  │  • Export formats │   │  • Toolbar buttons           │ │
│  │  • AI providers   │   │  • Context menu items        │ │
│  └──────────────────┘   └─────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 10.2 Plugin Manifest

Every plugin is described by a `plugin.toml` manifest:

```toml
[plugin]
id = "sqlpilot-redis-cache"
name = "Redis Cache Viewer"
version = "1.0.0"
description = "View and manage Redis caches alongside MySQL"
author = "Community"
license = "MIT"
min_app_version = "2.0.0"

[permissions]
ipc_commands = ["execute_query", "get_databases"] # Allowed core commands
network = false # No external network access
filesystem = ["read"] # Read-only filesystem access

[backend]
entry = "src/lib.rs" # Tauri plugin entry point

[frontend]
entry = "dist/index.js" # Bundled React component
panels = [
  { id = "redis-viewer", title = "Redis", icon = "database", position = "sidebar" },
]
context_menus = [
  { id = "copy-to-redis", title = "Copy to Redis", target = "result-cell" },
]
```

### 10.3 Extension Points

| Extension Point           | Mechanism                                                          | Example                                                 |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| **New IPC Commands**      | Tauri plugin system; register new `#[tauri::command]` functions    | A PostgreSQL plugin adding `pg_execute_query`           |
| **Custom Export Formats** | Implement `DataExporter` trait; register via plugin init           | Parquet, Avro, or Protocol Buffers exporter             |
| **Sidebar Panels**        | React component registered in the component registry               | Redis viewer, MongoDB browser, query planner visualizer |
| **Result View Tabs**      | React component rendered as an alternative result view             | Geo-map view for spatial data, chart auto-generator     |
| **Context Menu Items**    | Menu item definitions in manifest; handler in plugin code          | "Generate migration" on right-click table               |
| **Toolbar Buttons**       | Button definitions in manifest; click handler in plugin            | "Deploy to staging" button                              |
| **Themes**                | CSS file in `themes/` directory following CSS variable conventions | Corporate branding theme                                |

### 10.4 Sandboxing

Plugins run with restricted capabilities:

- **Backend plugins** execute within the Tauri process but have limited access to core services (only what `permissions` declares).
- **Frontend plugins** are loaded as separate React component trees with their own error boundaries. They cannot access other plugins' state directly — only through the event bus.
- **No arbitrary shell execution** — plugins cannot invoke system commands unless explicitly granted `shell` permission (which requires user approval).
- **Network access** is opt-in and displayed to the user during installation.

### 10.5 Plugin Lifecycle

```
Install:    Download → Verify signature → Extract → Register manifest
Enable:     Load backend module → Mount frontend components → Subscribe events
Disable:    Unmount components → Unsubscribe events → Unload module
Uninstall:  Disable → Remove files → Clean registry → Purge plugin data
Update:     Download new version → Disable old → Install new → Enable
```

---

## Appendix A: Glossary

| Term                   | Definition                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| **IPC**                | Inter-Process Communication — the message-passing channel between the Rust backend and React frontend |
| **Tauri Command**      | A Rust function annotated with `#[tauri::command]` that can be invoked from JavaScript                |
| **Tauri Event**        | A named, typed message emitted from Rust and received by JavaScript event listeners                   |
| **Connection Profile** | A saved set of parameters needed to connect to a MySQL server                                         |
| **Active Connection**  | A live, pooled database session with health monitoring                                                |
| **Stream Handle**      | An opaque identifier for a running streamed query, used for cancellation                              |
| **Schema Context**     | A subset of schema metadata (tables, columns, types) sent to the AI service for prompt enrichment     |
| **DDL**                | Data Definition Language — SQL statements that modify schema (CREATE, ALTER, DROP)                    |
| **DML**                | Data Manipulation Language — SQL statements that modify data (INSERT, UPDATE, DELETE)                 |

## Appendix B: Decision Records

### B.1 Why Tauri over Electron?

| Factor           | Tauri 2                             | Electron                                        |
| ---------------- | ----------------------------------- | ----------------------------------------------- |
| Binary size      | ~3 MB                               | ~150 MB                                         |
| Memory usage     | ~30 MB idle                         | ~100 MB idle                                    |
| Backend language | Rust (memory-safe, fast)            | Node.js (GC pauses)                             |
| Security         | Allowlist, CSP, no Node in renderer | Full Node access in renderer (unless sandboxed) |
| Auto-update      | Built-in                            | Requires electron-updater                       |

### B.2 Why sqlx over mysql_async?

- **Compile-time query checking** — catches SQL typos and type mismatches at build time
- **Built-in connection pooling** — no need for a separate pool library
- **Unified API** — same interface for MySQL, PostgreSQL, SQLite (future-proofing)
- **Active maintenance** — larger community, more frequent releases

### B.3 Why Zustand over Redux?

- **Bundle size** — ~1 KB vs ~7 KB (Redux Toolkit)
- **Boilerplate** — Zero; no action types, reducers, or dispatch
- **Learning curve** — Minimal; just functions and state objects
- **Performance** — Fine-grained subscriptions by default
- **Devtools** — Full Redux DevTools support via middleware

---

_This is a living document. It will be updated as the architecture evolves._
