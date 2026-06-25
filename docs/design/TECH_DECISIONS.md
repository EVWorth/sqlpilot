# SQLPilot — Technology Decisions

> Architecture Decision Records (ADRs) for major technology choices.
> Each decision follows the format: Context → Decision → Rationale → Risks → Mitigations.

---

## ADR-001: Tauri 2 over Electron

**Status:** Accepted\
**Date:** 2024-01\
**Category:** Application Framework

### Context

SQLPilot needs a cross-platform desktop framework to deliver a native-feeling application on Windows, macOS, and Linux. The primary candidates are:

- **Electron** — mature, proven (VS Code, Slack, Discord), Chromium-based
- **Tauri 2** — newer, Rust-based, uses the OS native WebView
- **Flutter** — cross-platform UI toolkit, Dart language
- **Qt** — C++ native UI, mature

The application is data-heavy (large result sets, real-time metrics) and must feel responsive. Users of database tools are particularly sensitive to memory usage and startup time because they often run multiple instances alongside MySQL and other development tools.

### Decision

**Use Tauri 2.0** as the application framework.

### Rationale

| Factor           | Tauri 2                                      | Electron                       |
| ---------------- | -------------------------------------------- | ------------------------------ |
| Bundle size      | ~10 MB                                       | ~100+ MB                       |
| Idle memory      | ~80 MB                                       | ~300+ MB                       |
| Startup time     | Sub-second                                   | 1–2 seconds                    |
| Backend language | Rust (native performance)                    | Node.js (JIT)                  |
| Security         | Sandbox by default, fine-grained permissions | Full Node.js access by default |
| Future mobile    | Tauri 2 supports iOS/Android                 | Not applicable                 |
| Ecosystem size   | Growing (smaller)                            | Mature (larger)                |

Key advantages for our use case:

1. **Rust backend** — MySQL protocol handling, SSH tunnels, file I/O, and data serialization all benefit enormously from Rust's performance. Serializing 100K rows to JSON is orders of magnitude faster in Rust than Node.js.
2. **Memory efficiency** — Database tools often stay open all day. 80 MB vs 300+ MB idle memory is significant for developers running MySQL, IDE, browser, and other tools simultaneously.
3. **Security sandbox** — Tauri's permission system means the WebView cannot access the filesystem, network, or shell without explicit Rust-side permission. This is critical for a tool that handles database credentials.
4. **Bundle size** — A 10 MB installer encourages adoption. Users are more willing to try a lightweight tool.
5. **Mobile future** — Tauri 2 introduces iOS and Android support, opening the door to a mobile companion app.

### Risks

| Risk                                                | Likelihood | Impact |
| --------------------------------------------------- | ---------- | ------ |
| Smaller ecosystem than Electron                     | High       | Medium |
| WebView rendering differences across platforms      | Medium     | Medium |
| Tauri 2 API stability (newer project)               | Medium     | Medium |
| Fewer community examples and Stack Overflow answers | High       | Low    |

### Mitigations

- **WebView differences:** Test on all three platforms in CI from day one. Use feature detection for WebView quirks. Avoid bleeding-edge CSS/JS features that may not be supported in WebKitGTK (Linux) or older WebKit (macOS).
- **Ecosystem:** The React ecosystem (our frontend choice) is fully available in Tauri. Only Electron-specific Node.js APIs (like `electron-store`, `electron-updater`) need Tauri equivalents, and Tauri provides its own plugins for storage, updater, shell, etc.
- **API stability:** Pin exact Tauri version, subscribe to release notes, budget time for migration if breaking changes occur.
- **Community:** Tauri's Discord and GitHub Discussions are active. The Tauri team is responsive. We contribute back fixes we find.

---

## ADR-002: React over Svelte/Vue/Leptos

**Status:** Accepted\
**Date:** 2024-01\
**Category:** Frontend Framework

### Context

The Tauri WebView renders standard HTML/CSS/JS. We need a frontend framework to build a complex, interactive UI with:

- Rich code editor (Monaco)
- Virtualized data grid (100K+ rows)
- Drag-and-drop schema designer
- Real-time metric charts
- Complex forms and dialogs

Candidates evaluated:

- **React 18+** — largest ecosystem, most component libraries
- **Svelte/SvelteKit** — compiler-based, smaller bundle, less boilerplate
- **Vue 3** — progressive framework, good DX
- **Leptos** — Rust-based WASM framework (all-Rust stack)
- **Solid** — fine-grained reactivity, React-like API

### Decision

**Use React 18+ with TypeScript.**

### Rationale

1. **Ecosystem breadth** — The components we need already exist and are battle-tested:
   - Monaco Editor → `@monaco-editor/react`
   - Data grid → TanStack Table + TanStack Virtual
   - ERD → React Flow
   - Charts → Recharts
   - Command palette → cmdk
   - Resizable panels → react-resizable-panels

   For Svelte or Leptos, many of these would need to be built from scratch or use less-maintained wrappers.

2. **Developer familiarity** — React is the most widely known frontend framework. This maximizes the contributor pool for an open-source project.

3. **TypeScript support** — React's TypeScript integration is excellent. Type inference for props, hooks, and context is mature and well-documented.

4. **Concurrent features** — React 18's concurrent rendering (`useTransition`, `Suspense`) helps keep the UI responsive during heavy operations like rendering large data grids.

5. **Stability** — React's API surface has been stable for years. Our UI code won't need frequent rewrites.

### Risks

| Risk                                           | Likelihood | Impact |
| ---------------------------------------------- | ---------- | ------ |
| React bundle size larger than Svelte           | High       | Low    |
| Virtual DOM overhead for very frequent updates | Medium     | Medium |
| Boilerplate for state management               | Medium     | Low    |

### Mitigations

- **Bundle size:** Vite's tree-shaking eliminates unused code. React + ReactDOM is ~40 KB gzipped — acceptable for a desktop app with no bandwidth constraints.
- **Virtual DOM overhead:** For the data grid (our most performance-sensitive component), we use TanStack Virtual which minimizes DOM nodes. For real-time charts, Recharts uses SVG directly. We profile with React DevTools and optimize with `React.memo`, `useMemo`, and `useCallback` where measured necessary.
- **Boilerplate:** Zustand (see ADR-006) eliminates Redux-style boilerplate while keeping state management simple.

---

## ADR-003: sqlx over Diesel/mysql_async

**Status:** Accepted\
**Date:** 2024-01\
**Category:** Rust MySQL Driver

### Context

The Rust backend needs a MySQL driver for:

- Connecting to MySQL 5.7, 8.x, and MariaDB 10/11
- Connection pooling
- Async query execution (Tokio runtime)
- Parameterized queries
- Streaming large result sets
- SSL/TLS support

Candidates:

- **sqlx** — async, compile-time checked queries, built-in pool
- **Diesel** — ORM, synchronous by default, strong type safety
- **mysql_async** — low-level async MySQL driver
- **sea-orm** — async ORM built on sqlx

### Decision

**Use sqlx** as the MySQL driver.

### Rationale

1. **Async/Tokio native** — sqlx is built on Tokio, which is Tauri 2's async runtime. No runtime conflicts.

2. **Compile-time query verification** — `sqlx::query!("SELECT id, name FROM users WHERE id = ?", user_id)` is checked against the database schema at compile time. This catches SQL errors before they reach production.

3. **Built-in connection pooling** — `sqlx::MySqlPool` provides connection pooling with configurable min/max connections, idle timeout, and health checks. No need for a separate pooling library.

4. **Multi-database support** — sqlx supports MySQL, PostgreSQL, and SQLite. If we ever add PostgreSQL support, the migration is straightforward.

5. **Streaming** — `sqlx::query().fetch()` returns a `Stream` that yields rows one at a time, enabling efficient handling of large result sets without loading everything into memory.

6. **No ORM overhead** — We're building a database tool that needs to work with arbitrary schemas. An ORM's type mapping would fight us. sqlx's raw SQL with type checking is the perfect middle ground.

### Why Not Diesel?

- Diesel is synchronous by default. While `diesel-async` exists, it's a community project with less stability.
- Diesel's ORM model assumes you define your schema in Rust. We need to work with arbitrary user schemas, making Diesel's schema inference a hindrance rather than a help.
- Diesel's connection pool (`r2d2`) is synchronous.

### Why Not mysql_async?

- mysql_async is lower-level: no built-in pooling, no compile-time checks.
- We'd need to add connection pooling (bb8 or deadpool) and write more boilerplate.
- sqlx provides everything mysql_async does, plus more.

### Risks

| Risk                                                                    | Likelihood | Impact |
| ----------------------------------------------------------------------- | ---------- | ------ |
| Compile-time checks require database at build time                      | High       | Medium |
| sqlx may not support MySQL-specific features (e.g., `LOAD DATA INFILE`) | Medium     | Low    |
| Connection pool behavior differences across MySQL versions              | Low        | Medium |

### Mitigations

- **Build-time DB requirement:** Use sqlx offline mode (`sqlx prepare`) to generate a JSON file of query metadata. CI and contributors can build without a running MySQL instance.
- **MySQL-specific features:** For features sqlx doesn't directly support, we can drop down to raw TCP or use the `mysql_async` crate for specific operations.
- **Version differences:** Integration tests run against MySQL 5.7, 8.0, and MariaDB 11 in CI (see Testing Strategy).

---

## ADR-004: Monaco Editor over CodeMirror

**Status:** Accepted\
**Date:** 2024-01\
**Category:** Code Editor Component

### Context

The SQL editor is one of the most-used components. It needs:

- SQL syntax highlighting (MySQL dialect)
- Autocomplete (table names, column names, SQL keywords)
- Multi-cursor editing
- Error markers (red squiggly on syntax errors)
- Code folding
- Find and replace
- Large file handling (10K+ line scripts)
- Keyboard shortcut system

Candidates:

- **Monaco Editor** — VS Code's editor engine, extracted as a standalone component
- **CodeMirror 6** — lightweight, modular, extensible editor

### Decision

**Use Monaco Editor** via `@monaco-editor/react`.

### Rationale

1. **VS Code familiarity** — Most developers already use VS Code. The keybindings, search UI, minimap, and command palette are instantly familiar. This reduces learning curve to near zero.

2. **Superior IntelliSense** — Monaco's autocomplete system supports:
   - Triggered suggestions (on `.` or typing)
   - Snippet completions
   - Parameter hints
   - Hover information
   - Go to definition (we can implement this for tables/columns)

   CodeMirror's autocomplete is functional but requires more custom work to achieve the same polish.

3. **Large file handling** — Monaco virtualizes rendering and handles files with 100K+ lines smoothly. This matters for viewing large SQL dumps or stored procedures.

4. **SQL language support** — `monaco-sql-languages` provides MySQL dialect highlighting and basic autocomplete out of the box. We extend it with schema-aware completions.

5. **Error markers** — Monaco's diagnostic API lets us underline SQL syntax errors with the exact line and column, just like VS Code does for TypeScript errors.

### Risks

| Risk                                      | Likelihood | Impact |
| ----------------------------------------- | ---------- | ------ |
| Monaco is ~2 MB (heavier than CodeMirror) | High       | Low    |
| Web workers required (CSP configuration)  | High       | Medium |
| Harder to customize appearance deeply     | Medium     | Low    |

### Mitigations

- **Bundle size:** 2 MB is negligible for a desktop app. We lazy-load the editor component so it doesn't block initial render.
- **Web workers:** Configure Tauri's CSP to allow blob: URLs for Monaco workers. This is a one-time setup documented in the codebase.
- **Customization:** Monaco supports custom themes via `defineTheme()`. For the SQL-specific UI we need (execute button, connection selector above editor), we wrap Monaco in our own component.

---

## ADR-005: TanStack Table over AG Grid/DataTables

**Status:** Accepted\
**Date:** 2024-01\
**Category:** Data Grid Component

### Context

The data grid is the second-most critical UI component (after the editor). Requirements:

- Display 100K+ rows with smooth scrolling
- Column sorting, filtering, resizing, reordering
- Inline cell editing
- Row selection
- Copy to clipboard in multiple formats
- Custom cell renderers (NULL, BLOB, JSON, dates)
- TypeScript type safety

Candidates:

- **AG Grid** — full-featured, commercial grid (free community edition available)
- **TanStack Table v8** — headless table library + TanStack Virtual for virtualization
- **React Data Grid** — open-source, opinionated grid
- **MUI DataGrid** — Material UI's grid component

### Decision

**Use TanStack Table v8 (headless) + TanStack Virtual** for the data grid.

### Rationale

1. **Headless architecture** — TanStack Table provides the logic (sorting, filtering, pagination, selection) but no UI. We render the cells ourselves. This gives us:
   - Full control over every pixel (critical for a database tool where data display IS the product)
   - No CSS conflicts with our design system
   - Custom cell renderers without fighting a framework
   - Ability to match the look and feel of professional database tools

2. **Virtualization** — TanStack Virtual renders only the visible rows (~50 DOM elements), regardless of the total row count. This enables smooth scrolling through 1M+ rows at 60 FPS.

3. **TypeScript-native** — TanStack Table is written in TypeScript with full generic support. Column definitions are type-safe end-to-end.

4. **MIT license** — Free for commercial use. AG Grid's community edition is MIT but limits features (no server-side row model, no clipboard, no Excel export in the free tier).

5. **Small bundle** — TanStack Table is ~15 KB gzipped. AG Grid is ~200+ KB. For a desktop app this matters less, but it still affects startup time.

### Risks

| Risk                                                                   | Likelihood | Impact |
| ---------------------------------------------------------------------- | ---------- | ------ |
| More custom code needed than AG Grid                                   | High       | Medium |
| Need to build features AG Grid provides out-of-box (clipboard, export) | High       | Medium |
| Performance tuning is our responsibility                               | Medium     | Medium |

### Mitigations

- **Custom code:** We build a reusable `<DataGrid>` component that encapsulates all TanStack Table configuration. Other parts of the app use this component, not TanStack Table directly. The upfront investment pays off in a component that exactly matches our UX requirements.
- **Missing features:** We implement clipboard (Clipboard API), export (backend handles format conversion), and other features ourselves. These are straightforward and give us more control over the behavior.
- **Performance:** We profile with React DevTools and Chrome Performance panel. TanStack Virtual's virtualization handles the majority of performance concerns. We memoize cell renderers and use `React.memo` on row components.

---

## ADR-006: Zustand over Redux/MobX/Jotai

**Status:** Accepted\
**Date:** 2024-01\
**Category:** State Management

### Context

The application has significant client-side state:

- Connection profiles and active connections
- Open editor tabs with content, cursor position, results
- Schema tree state (expanded nodes, cached metadata)
- UI preferences (theme, layout, shortcuts)
- AI chat history
- Notification queue

We need a state management solution that is:

- Type-safe with TypeScript
- Performant (minimal re-renders)
- Simple to learn and use
- Debuggable (dev tools)
- Compatible with React 18 concurrent features

Candidates:

- **Redux Toolkit** — industry standard, verbose but predictable
- **Zustand** — minimal, hook-based, small API surface
- **MobX** — observable-based, automatic reactivity
- **Jotai** — atomic state management
- **Recoil** — Facebook's experimental atomic state

### Decision

**Use Zustand v4.**

### Rationale

1. **Minimal boilerplate** — A Zustand store is a single function that returns an object. No reducers, actions, action types, or providers:

   ```typescript
   const useConnectionStore = create<ConnectionState>((set) => ({
     connections: [],
     activeId: null,
     connect: async (id) => {
       /* ... */ set({ activeId: id });
     },
     disconnect: () => set({ activeId: null }),
   }));
   ```

2. **Excellent TypeScript support** — Full type inference on store state and actions. No `as unknown as Type` gymnastics.

3. **Small bundle** — ~1 KB gzipped. Zustand adds virtually nothing to the bundle.

4. **Simple mental model** — Zustand stores are just JavaScript objects. There's no "flux architecture" to learn. New contributors can understand the state management in minutes.

5. **Selective subscriptions** — Components only re-render when the specific slice of state they use changes:

   ```typescript
   const activeId = useConnectionStore((s) => s.activeId);
   ```

6. **DevTools integration** — Zustand has a devtools middleware that works with the Redux DevTools browser extension.

7. **Slices pattern** — For large stores, Zustand supports splitting state into slices that compose into a single store. This provides Redux-like organization without Redux-like ceremony.

### Risks

| Risk                                               | Likelihood | Impact |
| -------------------------------------------------- | ---------- | ------ |
| Less structured than Redux for very large apps     | Medium     | Low    |
| No built-in middleware ecosystem                   | Medium     | Low    |
| Less familiar to developers from Redux backgrounds | Medium     | Low    |

### Mitigations

- **Structure:** Use the slices pattern to organize related state (connection slice, editor slice, schema slice, etc.). Each slice is in its own file with its own types.
- **Middleware:** Zustand provides `persist`, `devtools`, `immer`, and `subscribeWithSelector` middleware. These cover our needs. For anything else, Zustand middleware is a simple function wrapper.
- **Familiarity:** Zustand's API can be learned in 15 minutes. We document patterns in the codebase README.

---

## ADR-007: GitHub Copilot SDK for AI Features

**Status:** Accepted\
**Date:** 2024-01\
**Category:** AI Integration

### Context

AI features are a key differentiator for SQLPilot:

- Natural language → SQL query generation
- Query explanation in plain English
- Query optimization suggestions
- Schema documentation generation
- Inline SQL completions in the editor

We need an AI provider that:

- Generates high-quality SQL
- Understands database schemas
- Streams responses for responsive UX
- Is accessible to the target audience (developers)

Candidates:

- **GitHub Copilot SDK** — official SDK, GPT-4 class models, GitHub ecosystem
- **OpenAI API** — direct API access, requires API key and billing
- **Anthropic Claude API** — high-quality, requires API key

### Decision

**Use GitHub Copilot SDK as the AI provider.**

### Rationale

1. **Target audience alignment** — SQLPilot targets developers who very likely already have a GitHub Copilot subscription. No additional cost or API key management required.

2. **High-quality models** — Copilot uses GPT-4 class models that produce excellent SQL. The quality of NL→SQL generation is critical for the AI features to be useful.

3. **Official SDK** — The Copilot SDK handles authentication (GitHub token), rate limiting, and streaming. Less custom code than using raw OpenAI API.

   - Free and offline
   - Models like CodeLlama and SQLCoder are decent at SQL generation
   - No data leaves the user's machine (privacy-sensitive environments)

### Architecture

```
┌─────────────────────────────────────────────┐
│              AI Service (mas-ai)             │
│                                             │
│  ┌──────────┐    ┌──────────┐    ┌───────┐  │
│  │ Copilot  │───►│ Provider │───►│ Prompt│  │
│  │   SDK    │    │ Router   │    │ Engine│  │
│  └──────────┘    └──────────┘    └───────┘  │
│  ┌──────────┐         │                     │
│  │   HTTP   │                               │
│  └──────────┘                               │
└─────────────────────────────────────────────┘
```

The Provider Router selects the best available provider:

1. If Copilot SDK is authenticated → use Copilot
2. Otherwise → disable AI features

### Risks

| Risk                                        | Likelihood | Impact |
| ------------------------------------------- | ---------- | ------ |
| Copilot SDK requires active subscription    | High       | Medium |
| AI generates incorrect/dangerous SQL        | Medium     | High   |
| Copilot terms of service may restrict usage | Medium     | High   |
| Schema context exceeds token limits         | Medium     | Medium |
| AI latency disrupts UX                      | Medium     | Medium |

### Mitigations

- **Incorrect SQL:** Generated SQL is NEVER auto-executed. It's always inserted into the editor for user review. Dangerous statements (DROP, DELETE without WHERE) get a warning banner.
- **Terms of service:** Review Copilot SDK terms before release. Ensure our usage (IDE-like SQL assistance) aligns with intended use cases. Consult legal if ambiguous.
- **Token limits:** Intelligent schema pruning: only include tables and columns relevant to the conversation. For large schemas (200+ tables), use embedding-based relevance scoring to select the most pertinent tables.
- **Latency:** Stream all AI responses token-by-token. Show a typing indicator. Allow cancellation. Cache common explanations.

---

## ADR-008: SQLite for Local Storage over JSON Files

**Status:** Accepted\
**Date:** 2024-01\
**Category:** Local Persistence

### Context

The application needs to persist:

- Connection profiles (host, port, user, encrypted password, options)
- Query history (potentially thousands of entries)
- Saved/favorite queries
- Editor tab state (content, cursor position, connection binding)
- User preferences (theme, shortcuts, layout)
- AI chat history

Options:

- **JSON files** — simple, human-readable, no dependencies
- **SQLite** — embedded relational database, ACID transactions
- **IndexedDB** — browser-native, available in WebView
- **Tauri Store plugin** — key-value store built on JSON files

### Decision

**Use rusqlite (SQLite)** for all local persistence, accessed from the Rust backend.

### Rationale

1. **Query capability** — Query history can accumulate thousands of entries. SQLite enables:
   ```sql
   SELECT * FROM query_history
   WHERE sql_text LIKE '%users%'
   ORDER BY executed_at DESC
   LIMIT 50;
   ```
   With JSON files, this requires loading the entire file and filtering in memory.

2. **ACID transactions** — Saving a connection profile that includes credentials must be atomic. SQLite guarantees this. JSON files can be corrupted by partial writes (crash during write).

3. **Concurrent access** — SQLite handles concurrent reads safely with WAL mode. If we ever need multiple processes accessing the same data (e.g., a CLI companion tool), SQLite handles it.

4. **Schema evolution** — SQLite supports `ALTER TABLE` for schema migrations. As the app evolves, we add columns or tables without rewriting the entire storage format.

5. **Proven reliability** — SQLite is the most widely deployed database in the world. It's tested with billions of deployments. The risk of data loss is vanishingly small.

6. **Performance** — SQLite reads are sub-millisecond for our data volumes. There's no cold-start penalty like reading and parsing a large JSON file.

### Why Not JSON Files?

- **Corruption risk:** A crash during a JSON write can leave the file in a partially-written state. Recovery requires backup copies.
- **Performance:** As query history grows, loading and parsing a multi-megabyte JSON file on every read becomes slow.
- **No query capability:** Searching through history requires loading everything into memory.

### Why Not IndexedDB?

- **Frontend-only:** IndexedDB is only accessible from the WebView JavaScript context. We want the Rust backend to manage storage (closer to the encryption and keychain logic).
- **API complexity:** IndexedDB's async, event-based API is notoriously awkward.

### Data Model

```sql
-- Connection profiles
CREATE TABLE connections (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    host        TEXT NOT NULL,
    port        INTEGER NOT NULL DEFAULT 3306,
    username    TEXT NOT NULL,
    use_keychain BOOLEAN DEFAULT TRUE,
    database_name TEXT,
    ssl_config  TEXT,      -- JSON
    ssh_config  TEXT,      -- JSON
    options     TEXT,      -- JSON
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- Query history
CREATE TABLE query_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT REFERENCES connections(id),
    database_name TEXT,
    sql_text    TEXT NOT NULL,
    row_count   INTEGER,
    elapsed_ms  INTEGER,
    is_favorite BOOLEAN DEFAULT FALSE,
    executed_at TEXT NOT NULL
);
CREATE INDEX idx_history_connection ON query_history(connection_id);
CREATE INDEX idx_history_executed ON query_history(executed_at);
CREATE INDEX idx_history_favorite ON query_history(is_favorite);

-- Saved queries
CREATE TABLE saved_queries (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    sql_text    TEXT NOT NULL,
    connection_id TEXT REFERENCES connections(id),
    folder      TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- Editor tabs (restore on app restart)
CREATE TABLE editor_tabs (
    id          TEXT PRIMARY KEY,
    connection_id TEXT REFERENCES connections(id),
    database_name TEXT,
    title       TEXT NOT NULL,
    sql_text    TEXT NOT NULL,
    cursor_line INTEGER DEFAULT 1,
    cursor_col  INTEGER DEFAULT 1,
    is_active   BOOLEAN DEFAULT FALSE,
    sort_order  INTEGER DEFAULT 0
);

-- User preferences
CREATE TABLE preferences (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- AI chat history
CREATE TABLE ai_conversations (
    id          TEXT PRIMARY KEY,
    title       TEXT,
    connection_id TEXT REFERENCES connections(id),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE ai_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT REFERENCES ai_conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,  -- 'user' or 'assistant'
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
```

### Risks

| Risk                                      | Likelihood | Impact |
| ----------------------------------------- | ---------- | ------ |
| Additional dependency (SQLite C library)  | Low        | Low    |
| Database file corruption (extremely rare) | Very Low   | High   |
| Migration complexity as schema evolves    | Medium     | Medium |

### Mitigations

- **Dependency:** SQLite is embedded in rusqlite via bundled compilation. No system dependency required.
- **Corruption:** Enable WAL mode for crash safety. Implement periodic backup of the database file. SQLite's built-in integrity check can verify database health on startup.
- **Migrations:** Use a simple migration system (numbered SQL files in `migrations/` directory). Run pending migrations on app startup.

---

## ADR-009: Docker-based E2E Testing

**Status:** Accepted\
**Date:** 2024-01\
**Category:** Testing Infrastructure

### Context

Testing a database GUI requires a real database. Options:

- **Mock the database driver** — fast, isolated, but doesn't test real SQL compatibility
- **Embedded MySQL** — doesn't exist for Rust like H2 for Java
- **Docker containers** — real MySQL instances, reproducible, isolated
- **Remote test server** — shared, non-isolated, fragile

### Decision

**Use Docker Compose with multiple MySQL/MariaDB containers** for integration and E2E testing.

### Rationale

1. **Real database** — Our tests execute actual SQL against real MySQL. This catches compatibility issues that mocks would miss:
   - Syntax differences between MySQL 5.7 and 8.0
   - MariaDB-specific behavior
   - SSL/TLS handshake issues
   - Character set handling

2. **Reproducible** — Every developer and CI run starts with the exact same database state. No "it works on my machine" issues.

3. **Multi-version testing** — We test against MySQL 5.7, MySQL 8.0, and MariaDB 11 simultaneously. This ensures broad compatibility.

4. **Isolated** — Each test run gets fresh containers with no leftover state. Tests can't interfere with each other.

5. **SSL and SSH testing** — Docker makes it easy to set up an SSL-enabled MySQL instance and an SSH server for tunnel testing. These would be difficult to configure on bare CI runners.

### Container Matrix

| Container    | Port | Purpose                         |
| ------------ | ---- | ------------------------------- |
| `mysql-8`    | 3307 | Primary test target (MySQL 8.0) |
| `mysql-5.7`  | 3308 | Legacy version compatibility    |
| `mariadb`    | 3309 | MariaDB compatibility           |
| `mysql-ssl`  | 3310 | SSL/TLS connection testing      |
| `ssh-tunnel` | 2222 | SSH tunnel connection testing   |

### Risks

| Risk                                            | Likelihood | Impact |
| ----------------------------------------------- | ---------- | ------ |
| Docker required on developer machines           | High       | Medium |
| Container startup time (30–60s)                 | High       | Low    |
| Docker not available on all CI runners natively | Medium     | Medium |
| Flaky tests due to container health timing      | Medium     | Medium |

### Mitigations

- **Developer machines:** Document Docker requirement in README. Provide `docker compose up` as a one-command setup. For developers without Docker, unit tests (which mock the database) still run.
- **Startup time:** Containers start in parallel. Health checks prevent tests from starting before MySQL is ready. In CI, Docker layer caching reduces pull times.
- **CI runners:** GitHub Actions supports Docker on Ubuntu runners natively via `services`. For macOS/Windows runners (where Docker is limited), we run integration tests only on Ubuntu and run unit tests on all platforms.
- **Flaky health checks:** Use `mysqladmin ping` with generous retry counts (10 retries, 5s intervals). Add a secondary check that verifies the seed data is loaded before starting tests.

---

## ADR-010: Monorepo with Cargo Workspaces

**Status:** Accepted\
**Date:** 2024-01\
**Category:** Code Organization

### Context

The Rust backend has several distinct responsibilities:

- Connection management, query execution, schema introspection (core)
- AI service integration (AI)
- Import/export functionality (data tools)
- Database administration (admin)
- Tauri app shell and command handlers (app)

Putting everything in a single crate would create:

- Long compile times (any change recompiles everything)
- Tangled dependencies
- Difficult-to-test modules
- Unclear module boundaries

### Decision

**Use a Cargo workspace with multiple crates.**

### Structure

```
src-tauri/
├── Cargo.toml              # Workspace root
├── sqlpilot/        # Tauri app crate (binary)
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs          # Tauri entry point
│       └── commands/        # Tauri command handlers
│           ├── connection.rs
│           ├── query.rs
│           ├── schema.rs
│           ├── ai.rs
│           ├── export.rs
│           └── admin.rs
├── mas-core/               # Core library crate
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs
│       ├── connection/      # Connection profiles, pool management
│       ├── query/           # Query execution, cancellation, streaming
│       ├── schema/          # Schema introspection, caching
│       └── models/          # Shared data types
├── mas-ai/                 # AI service crate
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs
│       ├── copilot.rs       # GitHub Copilot SDK integration
│       ├── prompts/         # Prompt templates
│       └── router.rs        # Provider selection logic
├── mas-export/             # Import/export crate
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs
│       ├── csv.rs
│       ├── json.rs
│       ├── sql.rs
│       ├── xlsx.rs
│       ├── xml.rs
│       ├── markdown.rs
│       └── mapping.rs       # Column mapping engine
└── mas-admin/              # Administration crate
    ├── Cargo.toml
    └── src/
        ├── lib.rs
        ├── users.rs          # User/role management
        ├── processes.rs      # Process list, kill
        ├── variables.rs      # Server variables
        ├── maintenance.rs    # Table maintenance operations
        ├── backup.rs         # Backup/restore
        └── metrics.rs        # Server status metrics
```

### Rationale

1. **Parallel compilation** — Cargo compiles independent crates in parallel. Changing `mas-ai` doesn't recompile `mas-export`. On a 8-core machine, this can halve incremental build times.

2. **Clear dependency boundaries** — Each crate declares its dependencies explicitly in `Cargo.toml`. `mas-export` depends on `mas-core` (for query execution), but NOT on `mas-ai`. This prevents accidental coupling.

3. **Independent testing** — `cargo test -p mas-core` runs only core tests. `cargo test -p mas-ai` runs only AI tests. Developers working on a specific feature run only relevant tests, getting faster feedback.

4. **Reusability** — `mas-core` could be used by a CLI tool or a separate backend service without pulling in Tauri, AI, or export dependencies.

5. **Encapsulation** — Each crate exposes a public API and keeps implementation details private. The `sqlpilot` app crate depends on all library crates and wires them together via Tauri commands.

### Dependency Graph

```
sqlpilot (Tauri app)
├── mas-core     (connection, query, schema)
├── mas-ai       (AI service)
│   └── mas-core (schema context for AI prompts)
├── mas-export   (import/export)
│   └── mas-core (query execution for data access)
└── mas-admin    (administration)
    └── mas-core (connection and query execution)
```

### Risks

| Risk                                  | Likelihood | Impact |
| ------------------------------------- | ---------- | ------ |
| Inter-crate API design overhead       | Medium     | Low    |
| Shared type duplication across crates | Medium     | Medium |
| Workspace configuration complexity    | Low        | Low    |

### Mitigations

- **API design:** Start with a simple public API per crate. Refine boundaries as the codebase grows. Moving a module between crates is a mechanical refactor.
- **Shared types:** Common types (data models, error types) live in `mas-core::models`. All crates depend on `mas-core` for shared types. Alternatively, a tiny `mas-types` crate could hold just the shared types if `mas-core` becomes too heavy.
- **Workspace config:** Cargo workspaces are well-documented and widely used. The root `Cargo.toml` is simple:

  ```toml
  [workspace]
  members = [
    "sqlpilot",
    "mas-core",
    "mas-ai",
    "mas-export",
    "mas-admin",
  ]

  [workspace.dependencies]
  serde = { version = "1", features = ["derive"] }
  sqlx = { version = "0.7", features = ["mysql", "runtime-tokio", "tls-rustls"] }
  tokio = { version = "1", features = ["full"] }
  thiserror = "1"
  anyhow = "1"
  ```
