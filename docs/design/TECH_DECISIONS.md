# SQLPilot — Technology Decisions

> Architecture Decision Records (ADRs) for major technology choices.
> Each decision follows the format: Context → Decision → Rationale → Risks → Mitigations.
>
> Every ADR carries a `Status:` line: Accepted (in force) or Superseded (kept for
> history, with a pointer to what replaced it). Where the code has moved on from
> a detail in an accepted ADR, the ADR says what is there now.

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

- **WebView differences:** CI tests run on Linux only; the release workflow builds on Linux, Windows and macOS (Intel and Apple Silicon). Use feature detection for WebView quirks. Avoid bleeding-edge CSS/JS features that may not be supported in WebKitGTK (Linux) or older WebKit (macOS).
- **Ecosystem:** The React ecosystem (our frontend choice) is fully available in Tauri. Only Electron-specific Node.js APIs (like `electron-store`, `electron-updater`) need Tauri equivalents, and Tauri provides its own plugins for storage, updater, shell, etc.
- **API stability:** Keep the Tauri npm packages and crates on matching minor versions (`scripts/check-tauri-versions.sh`, run in CI), read release notes, budget time for migration if breaking changes occur.
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

- **React** — largest ecosystem, most component libraries
- **Svelte/SvelteKit** — compiler-based, smaller bundle, less boilerplate
- **Vue 3** — progressive framework, good DX
- **Leptos** — Rust-based WASM framework (all-Rust stack)
- **Solid** — fine-grained reactivity, React-like API

### Decision

**Use React with TypeScript.** React 18 at the time; React 19 today.

### Rationale

1. **Ecosystem breadth** — The components we need already exist and are battle-tested. In use today:
   - Monaco Editor → `@monaco-editor/react`
   - Data grid → TanStack Table + TanStack Virtual
   - Resizable panels → react-resizable-panels
   - Icons → lucide-react

   The command palette and table designer are our own components; there is no ERD or chart library.

   For Svelte or Leptos, many of these would need to be built from scratch or use less-maintained wrappers.

2. **Developer familiarity** — React is the most widely known frontend framework. This maximizes the contributor pool for an open-source project.

3. **TypeScript support** — React's TypeScript integration is excellent. Type inference for props, hooks, and context is mature and well-documented.

4. **Concurrent features** — React's concurrent rendering (`useTransition`, `Suspense`) helps keep the UI responsive during heavy operations like rendering large data grids.

5. **Stability** — React's API surface has been stable for years. Our UI code won't need frequent rewrites.

### Risks

| Risk                                           | Likelihood | Impact |
| ---------------------------------------------- | ---------- | ------ |
| React bundle size larger than Svelte           | High       | Low    |
| Virtual DOM overhead for very frequent updates | Medium     | Medium |
| Boilerplate for state management               | Medium     | Low    |

### Mitigations

- **Bundle size:** Vite's tree-shaking eliminates unused code. React + ReactDOM is ~40 KB gzipped — acceptable for a desktop app with no bandwidth constraints.
- **Virtual DOM overhead:** For the data grid (our most performance-sensitive component), we use TanStack Virtual which minimizes DOM nodes. We profile with React DevTools and optimize with `React.memo`, `useMemo`, and `useCallback` where measured necessary.
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

- **sqlx** — async, optional compile-time checked queries, built-in pool
- **Diesel** — ORM, synchronous by default, strong type safety
- **mysql_async** — low-level async MySQL driver
- **sea-orm** — async ORM built on sqlx

### Decision

**Use sqlx** as the MySQL driver.

### Rationale

1. **Async/Tokio native** — sqlx is built on Tokio, which is Tauri 2's async runtime. No runtime conflicts.

2. **Compile-time query verification (not used)** — sqlx can check `query!` macros against a schema at build time. SQLPilot runs arbitrary user SQL against arbitrary schemas, so the code uses the runtime API (`sqlx::query`, `sqlx::raw_sql`) and no build needs a database.

3. **Built-in connection pooling** — `sqlx::MySqlPool` provides connection pooling with configurable min/max connections, idle timeout, and health checks. No need for a separate pooling library.

4. **Multi-database support** — sqlx supports MySQL, PostgreSQL, and SQLite. If we ever add PostgreSQL support, the migration is straightforward.

5. **Streaming** — `fetch()` returns a `Stream` that yields rows one at a time. The backup writer uses it to dump tables without loading them into memory.

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
| sqlx may not support MySQL-specific features (e.g., `LOAD DATA INFILE`) | Medium     | Low    |
| Connection pool behavior differences across MySQL versions              | Low        | Medium |

### Mitigations

- **MySQL-specific features:** For features sqlx doesn't directly support, we can drop down to raw TCP or use the `mysql_async` crate for specific operations.
- **Version differences:** Integration tests run against MySQL 8 and MariaDB 11 at release time (see [TESTING_STRATEGY.md](TESTING_STRATEGY.md)). MySQL 5.7 is end-of-life and not tested.

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

4. **SQL language support** — Monaco's built-in `sql` and `mysql` language contributions provide highlighting. Completions are our own, schema-aware provider (`src/lib/schema-completion-provider.ts`).

5. **Error markers** — Monaco's diagnostic API can underline an error at an exact line and column. Not used today.

### Risks

| Risk                                                 | Likelihood | Impact |
| ---------------------------------------------------- | ---------- | ------ |
| Monaco is ~3.7 MB minified (heavier than CodeMirror) | High       | Low    |
| Web workers required (CSP configuration)             | High       | Medium |
| Harder to customize appearance deeply                | Medium     | Low    |

### Mitigations

- **Bundle size:** 3.7 MB is acceptable for a desktop app, but only after taking care over what is imported. `import * as monaco from "monaco-editor"` pulls in the TypeScript, CSS, HTML and JSON _language services_, whose web workers are another 10.8 MB — in a SQL client that edits none of those languages. The import is `editor.all` plus the SQL and MySQL contributions instead, which is the difference between a 17 MB and a 5.3 MB frontend build. The editor component is not lazy-loaded: it is the first thing on screen.
- **Web workers:** One worker, `editor.worker`, wired up in `main.tsx` through `MonacoEnvironment.getWorker`. The CSP in `tauri.conf.json` allows `worker-src 'self' blob:` for it.
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
- **TanStack Table** — headless table library + TanStack Virtual for virtualization
- **React Data Grid** — open-source, opinionated grid
- **MUI DataGrid** — Material UI's grid component

### Decision

**Use TanStack Table (headless) + TanStack Virtual** for the data grid. v8 at the time; v9 today.

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

- **Custom code:** One component, `ResultsGrid` (`src/components/grid/ResultsGrid.tsx`), encapsulates the TanStack Table configuration. Other parts of the app use this component, not TanStack Table directly. The upfront investment pays off in a component that exactly matches our UX requirements.
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

**Use Zustand.** v4 at the time; v5 today.

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

6. **DevTools integration** — Zustand has a devtools middleware that works with the Redux DevTools browser extension. Not wired up today.

7. **One store per domain** — Each concern (connections, editor, results, schema, history, favorites, settings, theme, and so on) is its own store in `src/stores/`, rather than slices of one store.

### Risks

| Risk                                               | Likelihood | Impact |
| -------------------------------------------------- | ---------- | ------ |
| Less structured than Redux for very large apps     | Medium     | Low    |
| No built-in middleware ecosystem                   | Medium     | Low    |
| Less familiar to developers from Redux backgrounds | Medium     | Low    |

### Mitigations

- **Structure:** One store per domain in `src/stores/`, each in its own file with its own types. Store actions own loading and error state; components do not call `api.*` directly.
- **Middleware:** Only `persist` is used (`favoritesStore`). Other stores that persist write `localStorage` themselves.
- **Familiarity:** Zustand's API can be learned in 15 minutes.

---

## ADR-007: GitHub Copilot SDK for AI Features

**Status:** Superseded by [ADR-011](#adr-011-bring-your-own-harness-instead-of-an-embedded-provider)\
**Date:** 2024-01\
**Category:** AI Integration

**What was decided.** Embed the GitHub Copilot SDK in a `mas-ai` crate and hold
the model session inside the app: natural language to SQL, query explanation,
optimisation hints and inline completions, behind a provider router, a prompt
engine, a rate limiter and a token budget. The reason was audience fit: the
target users likely already pay for Copilot, so no extra key or bill.

**Why it changed (2026-09).** Holding the session meant SQLPilot owned
credentials, provider abstraction, metering and a system prompt that schema
text was injected into, and it fixed the user's model choice. The rate limiter
and token budget were never built. ADR-011 replaced the design: SQLPilot is an
MCP server and the user's own harness holds the model session. `mas-ai` was
removed.

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

### What exists today

The decision held for app state the backend owns; the frontend keeps its own
preferences in `localStorage`.

- **SQLite via rusqlite, in `mas-core`** (not `mas-sqlite`, which is the
  user-facing SQLite file browser). Two files in the app data directory:
  `connections.db` (`connection_profiles`, `agent_grants`) and `history.db`
  (`query_history`, WAL mode).
- **Migrations** are versioned in code, with `PRAGMA user_version` as the
  cursor: `src-tauri/crates/mas-core/src/connection/migrations.rs` and
  `src-tauri/crates/mas-core/src/history/migrations.rs`.
- **Passwords** go to the OS credential store, not SQLite. Plaintext passwords
  from older versions are moved to the keyring on load.
- **In `localStorage`, not SQLite:** favorites, editor tabs, formatter and
  query settings, history limits, themes, grid layouts.
  [ARCHITECTURE.md](ARCHITECTURE.md) section 9 lists the keys.
- There are no saved-query folders, editor-tab or preference tables, and no AI
  conversation tables.

### Risks

| Risk                                      | Likelihood | Impact |
| ----------------------------------------- | ---------- | ------ |
| Additional dependency (SQLite C library)  | Low        | Low    |
| Database file corruption (extremely rare) | Very Low   | High   |
| Migration complexity as schema evolves    | Medium     | Medium |

### Mitigations

- **Dependency:** SQLite is embedded in rusqlite via bundled compilation. No system dependency required.
- **Corruption:** `history.db` uses WAL mode. A database that fails to open is reported at startup rather than crashing the app.
- **Migrations:** Numbered migrations in Rust source, applied on startup, each in a transaction.

---

## ADR-009: Docker-based E2E Testing

**Status:** Superseded (E2E suite removed; Docker databases still used for integration tests)\
**Date:** 2024-01\
**Category:** Testing Infrastructure

**What was decided.** Use Docker Compose with MySQL 5.7, MySQL 8, MariaDB 11,
an SSL-enabled MySQL and an SSH server, for both integration tests and a
Playwright end-to-end suite. Real servers catch dialect, character-set and TLS
differences that mocks miss.

**Why it changed.** The E2E suite never ran: it drove the Vite dev server, but
the app needs a Tauri window. It was removed; the Rust-to-JS contract is
covered by `src/lib/__tests__/tauri-command-contract.test.ts` and the bindings
check instead.

**What still holds.** Docker databases are how the Rust integration tests run:
MySQL 8 on 13306 and MariaDB 11 on 13308 from `docker-compose.test.yml`, the
same tests against both via `MAS_TEST_PORT`. Running against MariaDB found a
connection lost after every query timeout (#658) and JSON columns arriving as
binary. The 5.7 and SSL services are defined but never started; the SSH
container is gone because tunnelling is not implemented. See
[TESTING_STRATEGY.md](TESTING_STRATEGY.md).

---

## ADR-010: Monorepo with Cargo Workspaces

**Status:** Accepted\
**Date:** 2024-01\
**Category:** Code Organization

### Context

The Rust backend has several distinct responsibilities:

- Connection management, query execution, schema introspection (core)
- AI integration (originally an embedded AI service; now the MCP server and agent harness integration)
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

Members are listed in [`src-tauri/Cargo.toml`](../../src-tauri/Cargo.toml).

```
src-tauri/
├── Cargo.toml          # workspace root and the `sqlpilot` app crate (lib: sqlpilot_lib)
├── src/                # app crate: Tauri setup, commands/, mcp/, menu
├── tests/              # export_bindings.rs, agent_end_to_end.rs
└── crates/
    ├── mas-core/       # connections, queries, schema, backup/restore, history
    ├── mas-admin/      # process list, kill, server variables
    ├── mas-export/     # result export: CSV, JSON, SQL INSERT, Markdown
    ├── mas-sqlite/     # open and browse user SQLite files
    ├── mas-mcp/        # the MCP server agents use: tools, policy, grants, endpoint
    └── mas-agent/      # agent harness integration (ACP client, harness spawning)
```

### Rationale

1. **Parallel compilation** — Cargo compiles independent crates in parallel. Changing `mas-mcp` doesn't recompile `mas-export`. On a 8-core machine, this can halve incremental build times.

2. **Clear dependency boundaries** — Each crate declares its dependencies explicitly in `Cargo.toml`. `mas-export` depends on `mas-core` (for query execution), but NOT on `mas-mcp`. This prevents accidental coupling.

3. **Independent testing** — `cargo test -p mas-core` runs only core tests. `cargo test -p mas-mcp` runs only MCP tests. Developers working on a specific feature run only relevant tests, getting faster feedback.

4. **Reusability** — `mas-core` could be used by a CLI tool or a separate backend service without pulling in Tauri, MCP, or export dependencies.

5. **Encapsulation** — Each crate exposes a public API and keeps implementation details private. The `sqlpilot` app crate depends on all library crates and wires them together via Tauri commands.

### Dependency Graph

Normal dependencies only (`mas-core` also has `mas-admin` and `mas-export` as
dev-dependencies for its tests):

```
sqlpilot (Tauri app)
├── mas-core
├── mas-admin   ──► mas-core
├── mas-export  ──► mas-core
├── mas-mcp     ──► mas-core
├── mas-sqlite
└── mas-agent
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
- **Workspace config:** Shared dependency versions live in `[workspace.dependencies]` in the root `Cargo.toml`; crates inherit them with `workspace = true`.

---

## ADR-011: Bring your own harness, instead of an embedded provider

**Status:** Accepted\
**Date:** 2026-09\
**Category:** AI Integration\
**Supersedes:** ADR-007

### Context

ADR-007 put a Copilot SDK session inside the app. That shape requires SQLPilot
to hold credentials, abstract over providers, meter usage, and own a system
prompt that schema text is injected into. It also fixes the user's model choice
to whatever we integrated.

Meanwhile every harness worth supporting — Claude Code, Copilot, Codex, Gemini
CLI, Cursor, Continue — speaks the Model Context Protocol, and the people who
would use a SQL client's AI features already have one installed and
authenticated.

### Decision

**SQLPilot is an MCP server over its own live connections, not a model client.
The user brings their own harness.**

The app exposes schema, analysis, query and editor tools to whatever agent the
user runs, and enforces its own policy on every call. It never sees an API key,
never calls a model, and never accounts for a token.

### Rationale

1. **The credential problem disappears.** Not mitigated — gone. There is no key
   to store, rotate, leak or support. The user's harness is authenticated with
   their own subscription under their own terms.

2. **So does most of the security surface.** With no system prompt of ours,
   there is no prompt to inject into. What remains is making our _tools_ safe,
   which is testable in a way "did the model behave" is not.

3. **The user picks the model.** Including a local one, which for anyone whose
   data cannot leave the building is the difference between a usable feature
   and a banned one.

4. **The policy layer is the product.** An agent with a connection string has
   no row cap, no query timeout, no production guard and no redaction. Going
   through SQLPilot, it has all four — and that is worth more than another
   chat window.

5. **It works where the user already is.** The same server serves an editor
   agent in VS Code, so SQLPilot becomes useful to people who do not have it
   open.

### Consequences

- **The approval UI must be ours.** Harnesses have `--yolo`-shaped escape
  hatches, so a destructive action blocks on SQLPilot's own confirmation
  whatever is driving. See §2 of [AI_INTEGRATION.md](AI_INTEGRATION.md).
- **One adapter per harness for the in-app view.** Claude Code is driven
  over its own NDJSON stream and Copilot CLI over the Agent Client Protocol
  (`copilot --acp`); `mas-agent` normalises both. (When this ADR was written,
  Copilot exposed neither a structured stream nor a permission hook; ACP
  arrived later.) The tool surface does not depend on either.
- **No inline completions.** Those need an in-process model call. Autocomplete
  stays schema-driven, which is arguably the better trade for SQL anyway.
- **We do not embed an agent SDK.** Anthropic's terms do not permit a
  third-party product to offer claude.ai login through the Agent SDK; it
  expects an API key. Spawning the user's own CLI is what keeps this BYOH.
- **`mas-ai` was removed** rather than fixed: the prefix-check tool guards,
  the pinned git rev, the missing rate limiter and the prompt-injection
  surface belonged to the replaced design. `mas-mcp` and `mas-agent` took its
  place.

### Risks

| Risk                                               | Likelihood | Impact                                           |
| -------------------------------------------------- | ---------- | ------------------------------------------------ |
| Harness CLIs change shape under us                 | High       | Low — the tool surface does not depend on them   |
| A harness ships a mode that bypasses our approvals | Medium     | Low — approvals are ours, in our window          |
| MCP itself changes                                 | Medium     | Medium — it is versioned and we track a revision |
| User has no harness installed                      | Medium     | Low — say so plainly and link to one             |
