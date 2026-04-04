# MySQL AI Studio — Software Architecture Document

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

MySQL AI Studio is a cross-platform desktop application built on a **two-process architecture**: a Rust backend (Tauri 2) handles all database operations, file I/O, and system integration, while a React/TypeScript frontend renders the UI inside a native webview. The two halves communicate exclusively through Tauri's IPC bridge — a strongly-typed, JSON-serialized command/event channel.

### High-Level System Diagram

```
┌─────────────────────────────────────────────────────┐
│                   Frontend (React)                   │
│  ┌────────────┐ ┌────────────┐ ┌──────────────────┐ │
│  │ SQL Editor  │ │ Data Grid  │ │ Schema Explorer  │ │
│  │  (Monaco)   │ │ (TanStack) │ │   (Tree View)    │ │
│  └────────────┘ └────────────┘ └──────────────────┘ │
│  ┌────────────┐ ┌────────────┐ ┌──────────────────┐ │
│  │ ERD Canvas  │ │ Dashboard  │ │  AI Chat Panel   │ │
│  │(React Flow) │ │ (Recharts) │ │  (Copilot SDK)   │ │
│  └────────────┘ └────────────┘ └──────────────────┘ │
│  ┌────────────┐ ┌────────────┐ ┌──────────────────┐ │
│  │  Command    │ │ Resizable  │ │   Settings /     │ │
│  │  Palette    │ │  Panels    │ │   Preferences    │ │
│  │   (cmdk)    │ │            │ │                  │ │
│  └────────────┘ └────────────┘ └──────────────────┘ │
├─────────────────────────────────────────────────────┤
│               Tauri IPC Bridge                       │
│         (Commands ↑↓ Events / Streaming)             │
├─────────────────────────────────────────────────────┤
│                   Backend (Rust)                      │
│  ┌────────────┐ ┌────────────┐ ┌──────────────────┐ │
│  │ Connection  │ │   Query    │ │   AI Service     │ │
│  │  Manager    │ │  Executor  │ │  (Copilot SDK)   │ │
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
│  OS Process: mysql-ai-studio                                  │
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
│  │  • AI API calls      │                                    │
│  │  • Export operations  │                                    │
│  │  • Schema inspection  │                                    │
│  └──────────────────────┘                                    │
└──────────────────────────────────────────────────────────────┘
```

### Key Architectural Principles

| Principle | Description |
|---|---|
| **Separation of Concerns** | All database I/O and OS integration lives in Rust; the frontend is purely presentational and state-management |
| **Async Everywhere** | Every backend operation is non-blocking, powered by Tokio; the UI thread is never starved |
| **Stream by Default** | Large result sets and exports are streamed, not buffered; memory usage stays constant regardless of data size |
| **Offline First** | Core functionality (connect, query, browse) requires zero network beyond the MySQL target; AI features degrade gracefully |
| **Security by Design** | Credentials never leave the OS keychain; no secrets traverse IPC; Tauri's CSP and allowlist are strictly configured |

---

## 2. Technology Stack Details

### Frontend Stack

| Technology | Purpose | Version | Rationale |
|---|---|---|---|
| **React** | UI Framework | 18+ | Largest ecosystem, extensive component library support, concurrent rendering |
| **TypeScript** | Type Safety | 5.x | Catch errors at compile time, superior IDE experience, self-documenting APIs |
| **Vite** | Build Tool | 5.x | Sub-second HMR, ESBuild-powered bundling, first-class Tauri integration |
| **TanStack Table** | Data Grid | v8 | Headless & virtualized, handles 1M+ rows, fully customizable rendering |
| **TanStack Virtual** | Virtualization | v3 | Smooth scrolling for large datasets, row and column virtualization |
| **Monaco Editor** | SQL Editor | Latest | VS Code's editor engine, rich IntelliSense, bracket matching, minimap |
| **monaco-sql-languages** | SQL Support | Latest | MySQL dialect support, keyword autocomplete, syntax validation |
| **Zustand** | State Management | v4 | Lightweight (~1 KB), no boilerplate, supports middleware and devtools |
| **Tailwind CSS** | Styling | v3 | Utility-first, dark/light theming via CSS variables, minimal CSS bundle |
| **React Flow** | ERD Diagrams | v11 | Node-based graph rendering, pan/zoom, custom node types, minimap |
| **Recharts** | Charts | v2 | Declarative charting for dashboards, responsive, composable |
| **cmdk** | Command Palette | Latest | VS Code–style `Cmd+K` command palette, fuzzy search, keyboard navigation |
| **React Resizable Panels** | Layout | Latest | Draggable panel system, persistent sizes, nested layouts |
| **@tauri-apps/api** | Tauri Bridge | 2.x | Type-safe IPC invoke/listen, file dialogs, window management |

### Backend Stack

| Technology | Purpose | Version | Rationale |
|---|---|---|---|
| **Rust** | Language | 1.75+ | Memory safety without GC, zero-cost abstractions, fearless concurrency |
| **Tauri** | App Framework | 2.x | ~3 MB binary, OS-native webview, granular permission system |
| **sqlx** | MySQL Driver | 0.7+ | Async, compile-time checked queries, connection pooling, TLS built-in |
| **tokio** | Async Runtime | 1.x | Industry-standard async executor, timers, channels, task spawning |
| **serde** | Serialization | 1.x | Derive-based JSON/TOML/YAML (de)serialization, zero-copy where possible |
| **ssh2** | SSH Tunneling | 0.9+ | libssh2 bindings, public key and password auth, local port forwarding |
| **keyring** | Credentials | 2.x | Windows Credential Manager, macOS Keychain, Linux Secret Service/GNOME Keyring |
| **rusqlite** | Local Storage | 0.31+ | Embedded SQLite for connection profiles, query history, settings |
| **tracing** | Logging | 0.1+ | Structured, async-aware logging with span-based context propagation |
| **tracing-subscriber** | Log Output | 0.3+ | Formatters for console and file output, filtering by level/module |
| **uuid** | Identifiers | 1.x | UUIDv4 generation for connection IDs, session IDs, query handles |
| **thiserror** | Error Types | 1.x | Derive macro for ergonomic, typed error enums |
| **anyhow** | Error Context | 1.x | Contextual error wrapping for debugging, `.context("msg")` chains |
| **copilot-sdk** | AI Features | Latest | GitHub Copilot integration for NL→SQL, query explanation, optimization |
| **chrono** | Date/Time | 0.4+ | Timezone-aware datetime handling for MySQL temporal types |

### Development & Build Tools

| Tool | Purpose |
|---|---|
| **Tauri CLI** | Build, dev server, bundling for all platforms |
| **Cargo** | Rust dependency management and compilation |
| **pnpm** | Fast, disk-efficient JS package manager |
| **ESLint + Prettier** | Code style enforcement |
| **Clippy** | Rust linting |
| **Vitest** | Frontend unit tests |
| **Playwright** | End-to-end testing |
| **GitHub Actions** | CI/CD for multi-platform builds |

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

| Component | Responsibility |
|---|---|
| **ConnectionPool** | Wraps `sqlx::MySqlPool` with periodic health checks (`SELECT 1`), automatic reconnection, and configurable pool sizing |
| **SSHTunnel** | Manages `ssh2::Session` tunnels with local port forwarding; monitors tunnel liveness on a background Tokio task |
| **ConnectionRegistry** | Thread-safe, in-memory `DashMap<String, ActiveConnection>` of all live connections indexed by connection ID |
| **ConnectionStore** | `rusqlite`-backed persistence of `ConnectionProfile` records; passwords stored separately in the OS keychain via `keyring` |
| **HealthChecker** | Background task per connection that runs `SELECT 1` on an interval, emits `connection_health` events, and triggers reconnection on failure |

#### Reconnection Strategy

```
Attempt 1:  delay = 1s   + jitter(0–500ms)
Attempt 2:  delay = 2s   + jitter(0–500ms)
Attempt 3:  delay = 4s   + jitter(0–500ms)
Attempt 4:  delay = 8s   + jitter(0–500ms)
Attempt 5:  delay = 16s  + jitter(0–500ms)
Attempt 6+: delay = 30s  + jitter(0–500ms)   ← capped

After 10 consecutive failures → emit "connection_lost" event → surface reconnect dialog
```

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
  Emit event: "connection_established"
       │
       ▼
  Start HealthChecker background task
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
        params: Option<Vec<SqlValue>>,
    ) -> Result<QueryResult, QueryError>;

    /// Execute and stream rows back via Tauri events.
    async fn execute_stream(
        &self,
        connection_id: &str,
        sql: &str,
        app_handle: AppHandle,
    ) -> Result<StreamHandle, QueryError>;

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

| Feature | Implementation |
|---|---|
| **Streaming results** | Rows are fetched in configurable batches (default: 1000) and pushed to the frontend via Tauri `emit()` events. The frontend assembles them incrementally. |
| **Query cancellation** | Each query runs inside a `tokio::select!` with a cancellation token. On cancel, a separate connection sends `KILL QUERY <id>` to the MySQL server. |
| **Transaction tracking** | A per-connection state machine tracks `BEGIN` / `COMMIT` / `ROLLBACK` transitions. The UI displays the current transaction state. |
| **Timing & statistics** | Every execution records: wall-clock time, rows affected/returned, bytes transferred, warnings count. |
| **Parameterized queries** | Support for `?` placeholders with typed parameter binding via sqlx. |
| **Multi-statement execution** | Statements are split by `;` (respecting string literals and comments), executed sequentially, and each result set is tagged with its statement index. |
| **EXPLAIN integration** | One-click EXPLAIN or EXPLAIN ANALYZE with visual tree rendering on the frontend. |

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

| MySQL Source | What We Read |
|---|---|
| `INFORMATION_SCHEMA.SCHEMATA` | Database list, default character set, collation |
| `INFORMATION_SCHEMA.TABLES` | Table/view names, engine, row count estimate, data/index size |
| `INFORMATION_SCHEMA.COLUMNS` | Column name, type, nullable, default, extra (auto_increment), comment |
| `INFORMATION_SCHEMA.STATISTICS` | Index name, columns, uniqueness, type (BTREE/HASH/FULLTEXT) |
| `INFORMATION_SCHEMA.KEY_COLUMN_USAGE` | Foreign key relationships |
| `INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS` | ON DELETE / ON UPDATE rules |
| `INFORMATION_SCHEMA.TRIGGERS` | Trigger name, event, timing, statement |
| `INFORMATION_SCHEMA.ROUTINES` | Stored procedures and functions |
| `INFORMATION_SCHEMA.EVENTS` | Scheduled events |
| `INFORMATION_SCHEMA.PARTITIONS` | Partition definitions |
| `performance_schema.threads` | Active thread/connection metrics |
| `mysql.user` / `INFORMATION_SCHEMA.USER_PRIVILEGES` | User accounts and grants |

#### Caching Strategy

```
┌───────────────────────────────────────────────────┐
│              Schema Cache (per connection)          │
│                                                     │
│  Key: (connection_id, database, object_type)        │
│  Value: CachedSchema { data, fetched_at, ttl }     │
│                                                     │
│  TTL defaults:                                      │
│    Database list:  60 seconds                       │
│    Table list:     30 seconds                       │
│    Column details: 30 seconds                       │
│    Index details:  60 seconds                       │
│    Routines:      120 seconds                       │
│                                                     │
│  Invalidation triggers:                             │
│    • DDL execution detected (CREATE/ALTER/DROP)     │
│    • Manual refresh from UI                         │
│    • TTL expiration                                 │
│    • Connection reconnection                        │
└───────────────────────────────────────────────────┘
```

#### Change Notification

When the schema cache is invalidated (DDL detected or manual refresh), the backend emits a Tauri event:

```rust
app_handle.emit("schema_changed", SchemaChangeEvent {
    connection_id: String,
    database: String,
    change_type: SchemaChangeType,  // Created | Altered | Dropped
    object_type: String,            // "table", "column", "index", etc.
    object_name: String,
})?;
```

The frontend's `schemaStore` listens for these events and surgically updates the affected portion of the schema tree rather than re-fetching everything.

---

### 3.4 AI Service (Rust)

The AI Service integrates large language model capabilities into the application, with GitHub Copilot as the primary provider and local LLM support as a fallback.

#### Architecture

```
┌──────────────────────────────────────────────────────┐
│                    AI Service                         │
│                                                       │
│  ┌──────────────┐    ┌─────────────────────────────┐ │
│  │PromptBuilder │    │     Provider Abstraction     │ │
│  │              │    │                             │ │
│  │ • Schema     │    │ ┌─────────┐  ┌───────────┐ │ │
│  │   injection  │───►│ │Copilot  │  │  Ollama   │ │ │
│  │ • History    │    │ │  SDK    │  │  (local)  │ │ │
│  │ • System     │    │ └─────────┘  └───────────┘ │ │
│  │   prompt     │    │                             │ │
│  └──────────────┘    └─────────────────────────────┘ │
│                                                       │
│  ┌──────────────┐    ┌─────────────────────────────┐ │
│  │ Rate Limiter │    │  Conversation Manager       │ │
│  │              │    │  • Session history           │ │
│  │ • Token      │    │  • Context window mgmt      │ │
│  │   budget     │    │  • Message pruning           │ │
│  │ • Request    │    │                             │ │
│  │   throttle   │    └─────────────────────────────┘ │
│  └──────────────┘                                    │
└──────────────────────────────────────────────────────┘
```

#### Capabilities

| Feature | Description |
|---|---|
| **NL → SQL** | Converts natural language questions into MySQL queries. Schema context (table names, columns, types, FK relationships) is injected into the prompt so the model produces accurate, runnable SQL. |
| **Query Explanation** | Takes a SQL statement and produces a plain-English explanation of what it does, including potential performance implications. |
| **Query Optimization** | Accepts a SQL statement and its `EXPLAIN` output, then suggests index additions, query rewrites, or schema changes. |
| **Documentation Generation** | Generates Markdown documentation for tables, views, and stored procedures based on schema metadata. |
| **Error Diagnosis** | When a query fails, the error message and surrounding schema context are sent to the model for a human-readable explanation and fix suggestions. |
| **Chat Interface** | Free-form conversation with database context awareness; supports follow-up questions and multi-turn dialogue. |

#### Prompt Engineering

```rust
/// System prompt template for NL→SQL generation.
const NL_TO_SQL_SYSTEM_PROMPT: &str = r#"
You are a MySQL expert assistant embedded in MySQL AI Studio.
Generate valid MySQL queries based on the user's natural language request.

## Context
- MySQL version: {mysql_version}
- Current database: {database}

## Schema
{schema_ddl}

## Rules
1. Use only tables and columns present in the schema above.
2. Prefer explicit JOIN syntax over implicit joins.
3. Include appropriate WHERE clauses to avoid full table scans.
4. Use aliases for readability.
5. Output ONLY the SQL query — no explanation unless asked.
"#;
```

#### Fallback Strategy

```
1. Try GitHub Copilot SDK (primary)
   ├── Success → return result
   └── Failure (auth error, rate limit, network) →
2. Try Ollama local model (if configured)
   ├── Success → return result with "local model" indicator
   └── Failure (not configured, model not loaded) →
3. Return AIUnavailable error → frontend shows graceful fallback UI
```

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

| Exporter | Extension | Features |
|---|---|---|
| **CSVExporter** | `.csv` | Configurable delimiter, quoting, headers, encoding (UTF-8/Latin-1) |
| **JSONExporter** | `.json` | Array-of-objects or array-of-arrays, pretty-print option |
| **SQLExporter** | `.sql` | INSERT statements, CREATE TABLE included optionally, batch size configurable |
| **ExcelExporter** | `.xlsx` | Sheet per result set, auto-column-width, header styling |
| **MarkdownExporter** | `.md` | GitHub-flavored Markdown tables, alignment |
| **XMLExporter** | `.xml` | Configurable root/row element names, attribute vs. element mode |

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

| Category | Operations |
|---|---|
| **User Management** | `CREATE USER`, `ALTER USER`, `DROP USER`, `GRANT`, `REVOKE`, `SHOW GRANTS`, password changes, account locking |
| **Process Management** | `SHOW PROCESSLIST` (polling at configurable interval), `KILL <id>`, `KILL QUERY <id>`, filtering by user/database/state |
| **Server Variables** | `SHOW [GLOBAL\|SESSION] VARIABLES`, `SET` for modifiable variables, search/filter, diff between global and session values |
| **Table Maintenance** | `OPTIMIZE TABLE`, `REPAIR TABLE`, `ANALYZE TABLE`, `CHECK TABLE` — with multi-table batch support and progress tracking |
| **Backup** | `mysqldump` wrapper (detects binary on PATH), custom SQL-based dump for environments without mysqldump, schema-only or data-only modes, compression |
| **Server Metrics** | `SHOW GLOBAL STATUS`, `SHOW ENGINE INNODB STATUS`, uptime, connections, query throughput, buffer pool usage — exposed as time-series for the dashboard |

#### Process Monitor Architecture

```
┌─────────────────────────────────────────────┐
│           Admin Service                      │
│                                              │
│  start_process_monitor(connection_id, 2s)    │
│           │                                  │
│           ▼                                  │
│  ┌─────────────────────┐                    │
│  │  Background Task    │                    │
│  │  (tokio::spawn)     │                    │
│  │                     │                    │
│  │  loop {             │                    │
│  │    SHOW PROCESSLIST │                    │
│  │    emit("process_   │──► Frontend:       │
│  │      list_update")  │   Process table    │
│  │    sleep(interval)  │   auto-refreshes   │
│  │  }                  │                    │
│  └─────────────────────┘                    │
└─────────────────────────────────────────────┘
```

---

### 3.7 Frontend State Architecture (React / Zustand)

The frontend state is split into focused, independent Zustand stores. Each store owns a single domain and exposes actions that call Tauri IPC commands.

#### Store Map

```
src/stores/
├── connectionStore.ts    — Active connections, profiles, connection status
├── editorStore.ts        — Open tabs, editor content, cursor positions, dirty state
├── resultStore.ts        — Query results, pagination state, selected cells
├── schemaStore.ts        — Cached schema trees per connection, expanded nodes
├── settingsStore.ts      — User preferences, theme, keybindings, editor config
├── aiStore.ts            — AI chat history, pending suggestions, provider status
├── historyStore.ts       — Query history, favorites, pinned queries
└── uiStore.ts            — Panel sizes, sidebar state, modals, toasts, focus
```

#### Store Design Pattern

Every store follows the same pattern:

```typescript
import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';

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
            title: 'Untitled',
            content: '',
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

          const result = await invoke<QueryResult>('execute_query', {
            connectionId: tab.connectionId,
            sql: tab.content,
          });

          set((state) => ({
            tabs: state.tabs.map((t) =>
              t.id === activeTabId ? { ...t, results: result } : t
            ),
          }));
        },

        // ... more actions
      }),
      { name: 'editor-store' }
    ),
    { name: 'EditorStore' }
  )
);
```

#### Inter-Store Communication

Stores communicate through Zustand subscriptions and Tauri event listeners, not direct imports:

```
connectionStore ──(event: connection_established)──► schemaStore.loadSchema()
schemaStore     ──(event: schema_changed)──────────► editorStore.refreshAutocomplete()
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

### 4.2 Streaming Query Flow (Large Result Sets)

```
Frontend                         Rust Backend                    MySQL
   │                                 │                             │
   │ invoke("execute_query_stream")  │                             │
   │────────────────────────────────►│                             │
   │                                 │ sqlx::query().fetch()       │
   │                                 │────────────────────────────►│
   │                                 │                             │
   │                                 │◄── Row batch 1 (1000 rows) │
   │◄── event: "query_rows" ────────│                             │
   │    { rows: [...], partial: T }  │                             │
   │                                 │◄── Row batch 2 (1000 rows) │
   │◄── event: "query_rows" ────────│                             │
   │    { rows: [...], partial: T }  │                             │
   │          ...                    │          ...                │
   │                                 │◄── Final batch (350 rows)  │
   │◄── event: "query_rows" ────────│                             │
   │    { rows: [...], partial: F }  │                             │
   │                                 │                             │
   │◄── event: "query_complete" ────│                             │
   │    { total: 2350, time: 89ms }  │                             │
```

### 4.3 AI Query Generation Flow

```
 ┌──────────┐
 │   User   │
 └────┬─────┘
      │ Types: "Show top 10 customers by revenue last month"
      ▼
 ┌──────────────────┐
 │  AI Chat Panel    │
 └────────┬─────────┘
          │ aiStore.generateSQL(prompt)
          ▼
 ┌──────────────────┐
 │  invoke(          │
 │  "ai_generate_sql"│  → { prompt, schemaContext }
 │  )                │
 └────────┬─────────┘
          │
          ▼
 ┌──────────────────┐
 │  AI Service       │
 │                   │
 │  1. Load schema   │ ← SchemaInspector cache
 │     for current   │
 │     database      │
 │                   │
 │  2. Build prompt: │
 │     System prompt │
 │     + Schema DDL  │
 │     + User query  │
 │     + History     │
 │                   │
 │  3. Call Copilot  │ ──► GitHub Copilot API
 │     SDK           │ ◄── Streamed response
 └────────┬─────────┘
          │ Generated SQL
          ▼
 ┌──────────────────┐
 │  AI Chat Panel    │  ← Displays SQL in code block
 │                   │
 │  [Insert into     │  ← Click to insert into active editor tab
 │   Editor]         │
 │  [Execute]        │  ← Click to execute directly
 │  [Explain]        │  ← Click to get explanation
 └──────────────────┘
```

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

### 5.2 Query Commands

```rust
/// Execute a SQL statement and return the full result.
#[tauri::command]
async fn execute_query(
    connection_id: String,
    sql: String,
    params: Option<Vec<serde_json::Value>>,
    state: State<'_, AppState>,
) -> Result<QueryResult, AppError>;

/// Execute a SQL statement with streamed results via events.
/// Returns a handle that can be used to cancel the stream.
#[tauri::command]
async fn execute_query_stream(
    connection_id: String,
    sql: String,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<StreamHandle, AppError>;

/// Cancel a running query by its handle.
#[tauri::command]
async fn cancel_query(
    query_id: String,
    state: State<'_, AppState>,
) -> Result<(), AppError>;

/// Run EXPLAIN on a query and return the execution plan.
#[tauri::command]
async fn explain_query(
    connection_id: String,
    sql: String,
    analyze: Option<bool>,
    state: State<'_, AppState>,
) -> Result<ExplainResult, AppError>;

/// Format/beautify a SQL string.
#[tauri::command]
fn format_sql(sql: String) -> Result<String, AppError>;

/// Retrieve query history entries with optional search.
#[tauri::command]
async fn get_query_history(
    connection_id: Option<String>,
    search: Option<String>,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<HistoryEntry>, AppError>;
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

/// Get stored procedures and functions.
#[tauri::command]
async fn get_routines(
    connection_id: String,
    database: String,
    state: State<'_, AppState>,
) -> Result<Vec<Routine>, AppError>;

/// Force-refresh the schema cache for a database.
#[tauri::command]
async fn refresh_schema(
    connection_id: String,
    database: String,
    state: State<'_, AppState>,
) -> Result<(), AppError>;
```

### 5.4 AI Commands

```rust
/// Generate SQL from a natural language prompt.
#[tauri::command]
async fn ai_generate_sql(
    prompt: String,
    context: SchemaContext,
    state: State<'_, AppState>,
) -> Result<String, AppError>;

/// Explain a SQL query in plain English.
#[tauri::command]
async fn ai_explain_query(
    sql: String,
    state: State<'_, AppState>,
) -> Result<String, AppError>;

/// Suggest optimizations for a query given its EXPLAIN output.
#[tauri::command]
async fn ai_optimize_query(
    sql: String,
    explain: ExplainResult,
    state: State<'_, AppState>,
) -> Result<OptimizationSuggestion, AppError>;

/// General-purpose AI chat with database context.
#[tauri::command]
async fn ai_chat(
    message: String,
    history: Vec<ChatMessage>,
    context: Option<SchemaContext>,
    state: State<'_, AppState>,
) -> Result<ChatResponse, AppError>;

/// Check AI service availability and provider info.
#[tauri::command]
async fn ai_status(
    state: State<'_, AppState>,
) -> Result<AIStatus, AppError>;
```

### 5.5 Export / Import Commands

```rust
/// Export data to a file in the specified format.
#[tauri::command]
async fn export_data(
    config: ExportConfig,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<ExportResult, AppError>;

/// Import data from a file into a table.
#[tauri::command]
async fn import_data(
    config: ImportConfig,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<ImportResult, AppError>;

/// Preview the first N rows of an import file.
#[tauri::command]
async fn preview_import(
    file_path: String,
    format: ImportFormat,
    limit: Option<u32>,
) -> Result<ImportPreview, AppError>;
```

### 5.6 Admin Commands

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

/// Get user accounts and their privileges.
#[tauri::command]
async fn get_users(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<User>, AppError>;

/// Get server status metrics for dashboard display.
#[tauri::command]
async fn get_server_status(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<ServerStatus, AppError>;

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

### 5.7 Tauri Events (Backend → Frontend)

| Event Name | Payload | Description |
|---|---|---|
| `connection_established` | `ConnectionInfo` | A new connection is active |
| `connection_lost` | `{ connection_id, error }` | Connection dropped unexpectedly |
| `connection_health` | `{ connection_id, healthy, latency_ms }` | Periodic health check result |
| `query_rows` | `{ query_id, rows, partial }` | Streamed result batch |
| `query_complete` | `{ query_id, total_rows, time_ms }` | Stream finished |
| `query_error` | `{ query_id, error }` | Query execution failed |
| `schema_changed` | `SchemaChangeEvent` | DDL detected, cache invalidated |
| `export_progress` | `{ export_id, rows_done, total_est, pct }` | Export progress update |
| `import_progress` | `{ import_id, rows_done, total_est, pct }` | Import progress update |
| `process_list_update` | `Vec<Process>` | Polled process list refresh |
| `ai_stream_chunk` | `{ request_id, chunk, done }` | Streamed AI response token |

---

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
│  Rust: keyring::Entry::new("mysql-ai-studio", id)      │
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
│    { keychain_service: "mysql-ai-studio",               │
│      keychain_account: "<profile_id>" }                 │
│                                                         │
│  Password is retrieved at connect() time and held       │
│  only in memory for the duration of pool creation.      │
└────────────────────────────────────────────────────────┘
```

### 6.2 Tauri Security Model

| Layer | Configuration |
|---|---|
| **Command Allowlist** | Only explicitly registered `#[tauri::command]` functions are callable from the frontend. No filesystem, shell, or HTTP access is granted by default. |
| **Content Security Policy** | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src ipc: http://ipc.localhost` — blocks all external resource loading |
| **IPC Origin Check** | Tauri validates that IPC messages originate from the app's webview, not injected scripts |
| **Permission Scopes** | Tauri 2's granular permissions restrict each plugin/command to minimum required capabilities |
| **No Remote Content** | The frontend is bundled locally; no remote URLs are loaded in the webview |

### 6.3 Network Security

| Scenario | Protection |
|---|---|
| **Direct Connection** | Optional SSL/TLS (`ssl-mode=REQUIRED` or `VERIFY_IDENTITY`) with custom CA certificate support |
| **SSH Tunnel** | All MySQL traffic encrypted through SSH tunnel; supports Ed25519, RSA, and ECDSA keys |
| **Cloud Databases** | Enforced SSL for RDS, PlanetScale, etc.; certificate bundles included or user-provided |
| **AI API Calls** | HTTPS only; OAuth tokens stored in OS keychain; no query data logged server-side |

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

| Error Location | Handling Strategy |
|---|---|
| **React Error Boundary** | Wraps each major panel (editor, results, schema tree). Catches render crashes and shows a "Something went wrong" fallback with a retry button. |
| **IPC Errors** | Caught in store actions; parsed into typed errors; displayed as toast notifications with appropriate severity (info/warning/error). |
| **Query Errors** | Displayed inline in the results panel. If the error includes `line`/`column`, the corresponding position is highlighted in the Monaco editor with a red squiggly underline. |
| **Connection Errors** | Trigger a reconnection dialog with options: Retry Now, Retry with Different Credentials, Cancel. Auto-reconnect attempts run in the background. |
| **AI Errors** | Non-blocking; shown as a message in the AI chat panel. The application remains fully functional without AI. |
| **Export/Import Errors** | Displayed in the progress dialog. Partial exports are preserved (user can resume or discard). |

### 7.4 Graceful Degradation

```
Feature availability when dependencies are unavailable:

                  ┌─────────────┐
                  │ Full App     │ ← All features available
                  └──────┬──────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
   ┌──────────┐  ┌──────────┐  ┌──────────┐
   │ No AI    │  │ No SSH   │  │ No SSL   │
   │ Provider │  │ Keys     │  │ Certs    │
   └──────┬───┘  └──────┬───┘  └──────┬───┘
          │              │              │
          ▼              ▼              ▼
   AI panel shows   SSH connections  SSL connections
   "Configure AI    show setup       fall back to
   provider" msg.   instructions.    plaintext with
   All other        Password auth    a warning banner.
   features work.   still works.
```

---

## 8. Performance Optimization Strategies

### 8.1 Backend Optimizations

| Strategy | Implementation | Impact |
|---|---|---|
| **Connection Pooling** | `sqlx::MySqlPool` with configurable min/max connections (default: 1–5 per profile) | Eliminates connection setup overhead for repeated queries |
| **Schema Caching** | In-memory `HashMap` with TTL per object type; invalidated on DDL detection | Reduces INFORMATION_SCHEMA queries from seconds to microseconds |
| **Result Streaming** | Rows fetched in batches of 1,000 via `sqlx::query().fetch()`; pushed via Tauri events | Constant memory regardless of result size |
| **Binary Protocol** | `sqlx` uses MySQL's binary protocol by default for prepared statements | 2–5× less bandwidth than text protocol for numeric types |
| **Query Pagination** | Rust adds `LIMIT` / `OFFSET` for table browsing; frontend requests pages on demand | Only transfers visible data |
| **Async I/O** | Every database, file, and network operation is non-blocking via Tokio | Main thread and UI thread are never blocked |
| **SSH Tunnel Reuse** | One tunnel per SSH host; multiple MySQL connections share the same tunnel | Avoids SSH handshake per connection |

### 8.2 Frontend Optimizations

| Strategy | Implementation | Impact |
|---|---|---|
| **Row Virtualization** | TanStack Virtual renders only visible rows (~30–50 at a time) | Handles 1M+ rows without DOM bloat |
| **Column Virtualization** | Only visible columns are rendered; horizontal scroll triggers re-render | Wide tables (100+ columns) remain performant |
| **Lazy Schema Tree** | Databases load on connect; tables load on expand; columns load on expand | Fast initial load even with hundreds of databases |
| **Debounced Autocomplete** | Monaco completions fire after 150ms of idle typing | Prevents API spam during fast typing |
| **Web Worker for Monaco** | Syntax highlighting and validation run in a Web Worker | Keeps the UI thread responsive during editing |
| **Memoized Components** | `React.memo` on table cells, tree nodes, and tab headers | Prevents unnecessary re-renders in hot paths |
| **Zustand Selectors** | Fine-grained subscriptions (`useStore(s => s.field)`) | Components re-render only when their slice changes |
| **Persisted Panel Layout** | Panel sizes saved to localStorage; restored on launch | No layout recalculation on startup |

### 8.3 Performance Budgets

| Metric | Target | Measurement |
|---|---|---|
| App launch to interactive | < 2 seconds | Tauri window open + React hydration |
| Connection establishment | < 3 seconds | Profile select to schema tree populated |
| Simple query (100 rows) | < 200ms | Ctrl+Enter to results rendered |
| Large query (100K rows) | < 5 seconds | First batch visible in < 500ms |
| Schema tree expand | < 300ms | Click to children visible |
| Autocomplete popup | < 200ms | Keystroke to suggestions visible |
| Memory (idle, 1 connection) | < 150 MB | Measured via OS task manager |
| Binary size (installed) | < 30 MB | Platform-specific installer |

---

## 9. Local Storage Architecture

All application data is stored under the platform-appropriate data directory, managed by Tauri's `app_data_dir()`.

### Directory Structure

```
~/.mysql-ai-studio/                      (Linux: ~/.local/share/mysql-ai-studio/)
│                                         (macOS: ~/Library/Application Support/mysql-ai-studio/)
│                                         (Windows: %APPDATA%/mysql-ai-studio/)
│
├── config.toml                          — Application settings
├── connections.db                       — SQLite: connection profiles (no passwords)
├── history.db                           — SQLite: query history, favorites, pins
│
├── themes/                              — Custom CSS theme overrides
│   ├── monokai.css
│   └── solarized-dark.css
│
├── snippets/                            — User-defined SQL snippet library
│   ├── common.json
│   └── per-connection/
│       └── <profile_id>.json
│
├── backups/                             — Auto-saved editor content
│   └── <tab_id>_<timestamp>.sql         — Recovered on crash
│
├── logs/                                — Structured log files
│   ├── app.log                          — Current session
│   └── app.log.1                        — Rotated (max 5 × 10 MB)
│
└── cache/
    ├── schema/                          — Serialized schema metadata
    │   └── <connection_id>.json
    └── ai/                              — AI response cache
        └── <prompt_hash>.json           — TTL: 24 hours
```

### config.toml Schema

```toml
[general]
theme = "dark"                           # "dark" | "light" | "system" | custom name
language = "en"
check_updates = true
telemetry = false                        # No telemetry by default

[editor]
font_family = "JetBrains Mono, Fira Code, monospace"
font_size = 14
tab_size = 4
word_wrap = "off"                        # "off" | "on" | "wordWrapColumn"
minimap = true
line_numbers = true
auto_save_interval_secs = 30

[query]
default_limit = 1000                     # Auto-append LIMIT to SELECT queries
max_display_rows = 100_000
confirm_destructive = true               # Confirm DROP, TRUNCATE, DELETE w/o WHERE
auto_uppercase_keywords = false

[export]
default_format = "csv"
csv_delimiter = ","
csv_quote = "\""
include_headers = true

[ai]
provider = "copilot"                     # "copilot" | "ollama" | "none"
ollama_url = "http://localhost:11434"
ollama_model = "codellama"
max_context_tokens = 4096
```

### SQLite Schemas

#### connections.db

```sql
CREATE TABLE connection_profiles (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    "group"           TEXT,
    color             TEXT,
    host              TEXT NOT NULL,
    port              INTEGER NOT NULL DEFAULT 3306,
    username          TEXT NOT NULL,
    password_ref      TEXT NOT NULL,          -- keychain reference, NOT the password
    default_database  TEXT,
    ssh_config        TEXT,                   -- JSON blob
    ssl_config        TEXT,                   -- JSON blob
    pool_config       TEXT,                   -- JSON blob
    read_only         INTEGER NOT NULL DEFAULT 0,
    sort_order        INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_profiles_group ON connection_profiles("group");
```

#### history.db

```sql
CREATE TABLE query_history (
    id              TEXT PRIMARY KEY,
    connection_id   TEXT NOT NULL,
    database_name   TEXT,
    sql_text        TEXT NOT NULL,
    execution_time  INTEGER,                  -- milliseconds
    rows_affected   INTEGER,
    status          TEXT NOT NULL DEFAULT 'success',  -- 'success' | 'error'
    error_message   TEXT,
    is_favorite     INTEGER NOT NULL DEFAULT 0,
    executed_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_history_connection ON query_history(connection_id, executed_at DESC);
CREATE INDEX idx_history_favorite ON query_history(is_favorite) WHERE is_favorite = 1;
CREATE INDEX idx_history_fts ON query_history(sql_text);  -- For search

-- Auto-cleanup: keep last 10,000 entries per connection
CREATE TRIGGER cleanup_history
AFTER INSERT ON query_history
BEGIN
    DELETE FROM query_history
    WHERE id IN (
        SELECT id FROM query_history
        WHERE connection_id = NEW.connection_id
        ORDER BY executed_at DESC
        LIMIT -1 OFFSET 10000
    );
END;
```

---

## 10. Plugin Architecture (Future)

> **Status:** Planned for v2.0. This section describes the intended design; implementation details may change.

### 10.1 Overview

MySQL AI Studio will support a plugin system that allows third-party developers to extend both the backend (Rust) and frontend (React) of the application.

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
id = "mysql-ai-studio-redis-cache"
name = "Redis Cache Viewer"
version = "1.0.0"
description = "View and manage Redis caches alongside MySQL"
author = "Community"
license = "MIT"
min_app_version = "2.0.0"

[permissions]
ipc_commands = ["execute_query", "get_databases"]   # Allowed core commands
network = false                                      # No external network access
filesystem = ["read"]                                # Read-only filesystem access

[backend]
entry = "src/lib.rs"                                 # Tauri plugin entry point

[frontend]
entry = "dist/index.js"                              # Bundled React component
panels = [
    { id = "redis-viewer", title = "Redis", icon = "database", position = "sidebar" }
]
context_menus = [
    { id = "copy-to-redis", title = "Copy to Redis", target = "result-cell" }
]
```

### 10.3 Extension Points

| Extension Point | Mechanism | Example |
|---|---|---|
| **New IPC Commands** | Tauri plugin system; register new `#[tauri::command]` functions | A PostgreSQL plugin adding `pg_execute_query` |
| **Custom Export Formats** | Implement `DataExporter` trait; register via plugin init | Parquet, Avro, or Protocol Buffers exporter |
| **AI Providers** | Implement `AIProvider` trait; register as alternative to Copilot/Ollama | Anthropic Claude, Google Gemini, local GGUF models |
| **Sidebar Panels** | React component registered in the component registry | Redis viewer, MongoDB browser, query planner visualizer |
| **Result View Tabs** | React component rendered as an alternative result view | Geo-map view for spatial data, chart auto-generator |
| **Context Menu Items** | Menu item definitions in manifest; handler in plugin code | "Generate migration" on right-click table |
| **Toolbar Buttons** | Button definitions in manifest; click handler in plugin | "Deploy to staging" button |
| **Themes** | CSS file in `themes/` directory following CSS variable conventions | Corporate branding theme |

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

| Term | Definition |
|---|---|
| **IPC** | Inter-Process Communication — the message-passing channel between the Rust backend and React frontend |
| **Tauri Command** | A Rust function annotated with `#[tauri::command]` that can be invoked from JavaScript |
| **Tauri Event** | A named, typed message emitted from Rust and received by JavaScript event listeners |
| **Connection Profile** | A saved set of parameters needed to connect to a MySQL server |
| **Active Connection** | A live, pooled database session with health monitoring |
| **Stream Handle** | An opaque identifier for a running streamed query, used for cancellation |
| **Schema Context** | A subset of schema metadata (tables, columns, types) sent to the AI service for prompt enrichment |
| **DDL** | Data Definition Language — SQL statements that modify schema (CREATE, ALTER, DROP) |
| **DML** | Data Manipulation Language — SQL statements that modify data (INSERT, UPDATE, DELETE) |

## Appendix B: Decision Records

### B.1 Why Tauri over Electron?

| Factor | Tauri 2 | Electron |
|---|---|---|
| Binary size | ~3 MB | ~150 MB |
| Memory usage | ~30 MB idle | ~100 MB idle |
| Backend language | Rust (memory-safe, fast) | Node.js (GC pauses) |
| Security | Allowlist, CSP, no Node in renderer | Full Node access in renderer (unless sandboxed) |
| Auto-update | Built-in | Requires electron-updater |

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

*This is a living document. It will be updated as the architecture evolves.*
