# SQLPilot — Development Plan

> A cross-platform MySQL GUI built with **Tauri 2 (Rust)** + **React (TypeScript)**.
> Each phase builds on the previous one. Milestones are defined by acceptance criteria that must pass before moving forward.

---

## Phase 0: Project Scaffolding & Infrastructure

**Goal:** Establish the foundation so that every subsequent phase starts with a working build, test, and CI pipeline.

### Key Deliverables

| #   | Deliverable                                 | Details                                                                                                  |
| --- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 0.1 | Tauri 2 + React + TypeScript + Vite project | `npm create tauri-app` with React-TS template, Vite 5+                                                   |
| 0.2 | Tailwind CSS, ESLint, Prettier              | Tailwind v3+, ESLint flat config, Prettier integrated with ESLint                                        |
| 0.3 | Cargo workspace                             | Root workspace containing `sqlpilot` (Tauri app), `mas-core`, `mas-ai`, `mas-export`, `mas-admin` crates |
| 0.4 | CI/CD                                       | GitHub Actions matrix build/test on `ubuntu-latest`, `windows-latest`, `macos-latest`                    |
| 0.5 | Docker Compose for MySQL                    | `docker-compose.test.yml` with MySQL 8.0, MySQL 5.7, MariaDB 11, SSL-enabled MySQL, SSH tunnel container |
| 0.6 | Testing frameworks                          | Vitest (frontend unit), `cargo test` (backend unit), Playwright (E2E)                                    |
| 0.7 | Shared types                                | `ts-rs` or `specta` to auto-generate TypeScript types from Rust structs                                  |
| 0.8 | Pre-commit hooks                            | `husky` + `lint-staged` running `rustfmt`, `clippy`, `eslint`, `prettier`                                |

### Dependencies on Prior Phases

- None — this is the first phase.

### Acceptance Criteria

- [ ] `cargo build` succeeds for all workspace crates.
- [ ] `npm run dev` launches the Tauri app with a blank React page.
- [ ] `cargo test` and `npm run test` pass with zero tests (frameworks configured).
- [ ] GitHub Actions workflow runs on all three OS targets and passes.
- [ ] `docker compose -f docker-compose.test.yml up -d` brings up all MySQL containers and health checks pass.
- [ ] Pre-commit hooks block a commit with a `clippy` warning or ESLint error.
- [ ] A change to a Rust struct auto-generates an updated `.ts` type file.

### Risk Factors

| Risk                                        | Impact | Mitigation                                                              |
| ------------------------------------------- | ------ | ----------------------------------------------------------------------- |
| Tauri 2 is newer; breaking changes possible | Medium | Pin exact Tauri version, watch release notes                            |
| WebView differences across OS               | Medium | Test on all three platforms in CI from day one                          |
| Docker not available on all CI runners      | Low    | Use `services` in GitHub Actions; document local setup for contributors |

---

## Phase 1: Core Connection & Query Engine

**Goal:** Users can create connection profiles, connect to MySQL, execute queries, and see results.

### Key Deliverables

#### Backend (Rust — `mas-core`)

| #   | Deliverable                   | Details                                                                 |
| --- | ----------------------------- | ----------------------------------------------------------------------- |
| 1.1 | Connection profile data model | `serde` serialization, `rusqlite` persistence, encrypted password field |
| 1.2 | Connection manager            | `sqlx::MySqlPool` per profile, configurable pool size, idle timeout     |
| 1.3 | SSH tunnel                    | `ssh2` crate; spawn tunnel thread, forward local port to remote MySQL   |
| 1.4 | SSL/TLS support               | Custom CA cert, client cert/key, `VERIFY_IDENTITY` mode                 |
| 1.5 | Single-statement execution    | Execute one SQL statement, return column metadata + rows                |
| 1.6 | Multi-statement execution     | Split on `;`, execute sequentially, return array of result sets         |
| 1.7 | Query cancellation            | `KILL QUERY <id>` on a separate connection                              |
| 1.8 | Error handling                | `thiserror` for library errors, `anyhow` at Tauri command boundary      |
| 1.9 | Keychain integration          | `keyring` crate for OS-native credential storage                        |

#### Frontend (React)

| #    | Deliverable            | Details                                                                |
| ---- | ---------------------- | ---------------------------------------------------------------------- |
| 1.10 | App shell layout       | Header, collapsible sidebar, resizable main panel, status bar          |
| 1.11 | Resizable panel system | `react-resizable-panels` or equivalent                                 |
| 1.12 | Connection dialog      | Create / Edit / Test connection form with validation                   |
| 1.13 | Connection sidebar     | List saved connections, show connected state, right-click context menu |
| 1.14 | Monaco SQL editor      | Single-tab editor, syntax highlighting, `Ctrl+Enter` to execute        |
| 1.15 | Results grid           | TanStack Table rendering column headers + rows                         |
| 1.16 | Status bar             | Active connection name, query elapsed time, row count                  |

### Dependencies on Prior Phases

- Phase 0 complete (build pipeline, Docker MySQL, testing frameworks).

### Acceptance Criteria

- [ ] User can create a connection profile via the UI, and it persists across app restarts.
- [ ] Connecting to MySQL 8.0 via Docker succeeds; status bar shows "Connected".
- [ ] SSH tunnel connection to MySQL through the test SSH container succeeds.
- [ ] SSL connection to the SSL-enabled MySQL container succeeds.
- [ ] Typing `SELECT * FROM users LIMIT 10;` and pressing `Ctrl+Enter` shows results in the grid.
- [ ] Multi-statement queries return separate result sets.
- [ ] Cancelling a `SELECT SLEEP(60)` query stops execution within 2 seconds.
- [ ] Invalid credentials show a clear error message in the connection dialog.
- [ ] All backend tests pass: `cargo test -p mas-core`.
- [ ] All frontend tests pass: `npm run test`.

### Risk Factors

| Risk                                          | Impact | Mitigation                                               |
| --------------------------------------------- | ------ | -------------------------------------------------------- |
| SSH tunnel stability                          | High   | Implement heartbeat/keep-alive, auto-reconnect logic     |
| Connection pool exhaustion                    | Medium | Expose pool size in settings, monitor active connections |
| WebView Content Security Policy blocks Monaco | Medium | Configure Tauri CSP to allow Monaco worker blobs         |

---

## Phase 2: Schema Browser & Multi-Tab Editor

**Goal:** Users can browse database objects in a tree view and work with multiple query tabs.

### Key Deliverables

#### Backend (Rust — `mas-core`)

| #   | Deliverable                  | Details                                                                                       |
| --- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| 2.1 | Schema introspection service | Queries against `INFORMATION_SCHEMA` for databases, tables, views, routines, triggers, events |
| 2.2 | Metadata caching             | In-memory cache with configurable TTL; invalidation on DDL execution                          |
| 2.3 | Table DDL generation         | `SHOW CREATE TABLE`, `SHOW CREATE VIEW`, etc.                                                 |
| 2.4 | Routine introspection        | Procedure/function parameter metadata, body source                                            |

#### Frontend (React)

| #    | Deliverable                     | Details                                                               |
| ---- | ------------------------------- | --------------------------------------------------------------------- |
| 2.5  | Schema tree view                | Collapsible tree with lazy loading per node level                     |
| 2.6  | Multi-tab editor                | Create, close, reorder (drag) tabs; each tab has its own editor state |
| 2.7  | Tab-specific connection binding | Each tab remembers which connection + database it targets             |
| 2.8  | Drag schema objects into editor | Drag a table name from tree into Monaco to insert identifier          |
| 2.9  | Context menus                   | Right-click on table → Open, Script as SELECT/INSERT/CREATE, Drop     |
| 2.10 | Table detail panel              | Columns, indexes, foreign keys, triggers in a tabbed inspector        |
| 2.11 | Breadcrumb navigation           | Connection → Database → Object path shown above editor                |

### Dependencies on Prior Phases

- Phase 1 complete (connection manager, basic query execution, app shell).

### Acceptance Criteria

- [ ] Schema tree lists all databases on the connected server.
- [ ] Expanding a database shows Tables, Views, Procedures, Functions, Triggers, Events folders.
- [ ] Expanding Tables lazily loads table names without blocking the UI.
- [ ] User can open 10+ editor tabs and switch between them without losing state.
- [ ] Each tab can target a different database on the same connection.
- [ ] Dragging a table name from the tree into the editor inserts the backtick-quoted name.
- [ ] Right-click → "Script as SELECT" opens a new tab with `SELECT * FROM \`table\` LIMIT 100;`.
- [ ] Table detail panel shows correct column types, indexes, and foreign keys.
- [ ] Schema cache refreshes when user executes a DDL statement.
- [ ] All new tests pass.

### Risk Factors

| Risk                                               | Impact | Mitigation                                                         |
| -------------------------------------------------- | ------ | ------------------------------------------------------------------ |
| `INFORMATION_SCHEMA` queries slow on large servers | High   | Cache aggressively, lazy load, use `SHOW` commands where faster    |
| Drag-and-drop cross-browser issues                 | Medium | Test on Windows (Edge WebView2), macOS (WebKit), Linux (WebKitGTK) |

---

## Phase 3: Advanced Data Grid & Editing

**Goal:** The data grid becomes a full-featured data editor with virtualization, inline editing, and export.

### Key Deliverables

#### Backend (Rust — `mas-core`)

| #   | Deliverable           | Details                                                                      |
| --- | --------------------- | ---------------------------------------------------------------------------- |
| 3.1 | Streaming result sets | Emit rows via Tauri events in configurable batch sizes                       |
| 3.2 | Row mutation API      | Generate `INSERT`, `UPDATE`, `DELETE` statements from grid edits; require PK |
| 3.3 | Data type parsing     | Parse MySQL types → Rust types → JSON-safe representations                   |
| 3.4 | BLOB/binary handling  | Return Base64 for display; allow download as file                            |
| 3.5 | NULL handling         | Distinct `null` representation in protocol (not empty string)                |

#### Frontend (React)

| #    | Deliverable                  | Details                                                         |
| ---- | ---------------------------- | --------------------------------------------------------------- |
| 3.6  | Virtualized data grid        | TanStack Virtual; smooth scroll through 100K+ rows at 60 FPS    |
| 3.7  | Inline cell editing          | Click cell → edit in place → commit on Enter / revert on Escape |
| 3.8  | Multi-column sorting         | Click column header to sort; shift-click for multi-sort         |
| 3.9  | Column filtering             | Per-column filter inputs (text, numeric range, NULL/NOT NULL)   |
| 3.10 | Column resizing & reordering | Drag column edges to resize; drag headers to reorder            |
| 3.11 | Copy as formats              | Right-click → Copy as INSERT / UPDATE / CSV / JSON / Markdown   |
| 3.12 | NULL styling                 | Italic gray `NULL` text, distinct from empty string             |
| 3.13 | JSON/XML cell viewer         | Expand cell to formatted JSON/XML viewer on click               |
| 3.14 | Pagination controls          | Page size selector (50 / 100 / 500 / 1000 / All)                |
| 3.15 | Export from grid             | Export current result set to CSV / JSON / SQL                   |

### Dependencies on Prior Phases

- Phase 1 (query execution, basic grid).
- Phase 2 (schema introspection for PK detection needed by row mutation API).

### Acceptance Criteria

- [ ] Querying a 100K-row table renders the first page in under 500ms.
- [ ] Scrolling through 100K rows maintains 60 FPS (no visible jank).
- [ ] Editing a cell and pressing Enter generates the correct `UPDATE` statement and applies it.
- [ ] Inserting a new row opens an empty row at the top of the grid; submitting generates `INSERT`.
- [ ] Deleting a row prompts for confirmation and generates `DELETE`.
- [ ] Sorting by two columns produces correct SQL `ORDER BY`.
- [ ] Copy as INSERT produces a valid `INSERT INTO ... VALUES (...)` statement.
- [ ] NULL values display as styled `NULL` and are distinguishable from empty strings.
- [ ] BLOB columns show `(BLOB: 1.2 KB)` with a download button.
- [ ] JSON columns render formatted JSON in an expandable viewer.
- [ ] Export to CSV of 50K rows completes in under 5 seconds.

### Risk Factors

| Risk                             | Impact | Mitigation                                                   |
| -------------------------------- | ------ | ------------------------------------------------------------ |
| Large result set memory pressure | High   | Stream rows, limit in-memory buffer, use pagination          |
| Inline editing without PK        | Medium | Disable editing for tables without PK; warn user             |
| Data type round-trip fidelity    | Medium | Extensive type tests, especially for DECIMAL, DATETIME, JSON |

---

## Phase 4: AI Integration

**Goal:** Users can generate SQL from natural language, get query explanations, and receive optimization suggestions.

### Key Deliverables

#### Backend (Rust — `mas-ai`)

| #   | Deliverable                    | Details                                                                             |
| --- | ------------------------------ | ----------------------------------------------------------------------------------- |
| 4.1 | GitHub Copilot SDK integration | Authenticate via GitHub token, send prompts, receive completions                    |
| 4.3 | Schema context builder         | Serialize relevant schema (tables, columns, types, FKs) into compact prompt context |
| 4.4 | Prompt templates               | Separate templates for: NL→SQL, explain, optimize, document, fix error              |
| 4.5 | Response streaming             | Stream AI response tokens via Tauri events for live rendering                       |
| 4.6 | Rate limit management          | Track token usage, respect rate limits, queue requests                              |

#### Frontend (React)

| #    | Deliverable               | Details                                                                   |
| ---- | ------------------------- | ------------------------------------------------------------------------- |
| 4.7  | AI chat sidebar           | Collapsible panel; conversation history; context-aware                    |
| 4.8  | NL→SQL input              | Text input with "Generate SQL" button; inserts result into editor         |
| 4.9  | Query explanation         | "Explain this query" action on selected SQL; renders Markdown explanation |
| 4.10 | Optimization suggestions  | "Optimize" action; shows cards with suggested changes and rationale       |
| 4.11 | Schema documentation      | AI-generated documentation for tables/columns; editable                   |
| 4.12 | Inline editor suggestions | Ghost-text suggestions in Monaco (like Copilot in VS Code)                |

### Dependencies on Prior Phases

- Phase 1 (connection, query execution).
- Phase 2 (schema introspection for context building).

### Acceptance Criteria

- [ ] User types "Show me all orders placed in the last 7 days with customer names" → valid SQL is generated.
- [ ] Generated SQL references actual table/column names from the connected schema.
- [ ] "Explain" on a complex JOIN query produces a human-readable explanation.
- [ ] "Optimize" on a query missing an index suggests adding one.
- [ ] AI responses stream token-by-token in the chat panel.
- [ ] When no AI provider is available, AI features are disabled with a clear message.
- [ ] Rate limit errors are handled gracefully with retry-after indication.

### Risk Factors

| Risk                               | Impact | Mitigation                                                                     |
| ---------------------------------- | ------ | ------------------------------------------------------------------------------ |
| AI generates incorrect SQL         | High   | Always show generated SQL for user review before execution; never auto-execute |
| Schema context exceeds token limit | Medium | Intelligent schema pruning: only send tables referenced in conversation        |
| AI latency impacts UX              | Medium | Streaming responses, loading indicators, ability to cancel                     |

---

## Phase 5: Visual Schema Designer (ERD)

**Goal:** Users can view and edit database schemas visually using an entity-relationship diagram.

### Key Deliverables

#### Backend (Rust — `mas-core`)

| #   | Deliverable                   | Details                                                                            |
| --- | ----------------------------- | ---------------------------------------------------------------------------------- |
| 5.1 | DDL generation from ERD       | Convert visual model to `CREATE TABLE`, `ALTER TABLE`, `ADD CONSTRAINT` statements |
| 5.2 | DDL → ERD reverse engineering | Parse existing schema into ERD model with positions                                |
| 5.3 | Schema diff                   | Compare two ERD states → generate migration DDL                                    |

#### Frontend (React)

| #    | Deliverable            | Details                                                           |
| ---- | ---------------------- | ----------------------------------------------------------------- |
| 5.4  | React Flow ERD canvas  | Pannable, zoomable canvas using React Flow                        |
| 5.5  | Table nodes            | Each table rendered as a card showing columns, types, PK/FK icons |
| 5.6  | Relationship edges     | FK relationships rendered as lines with cardinality notation      |
| 5.7  | Drag-and-drop creation | Drag from palette to create new table/column                      |
| 5.8  | Auto-layout            | Dagre or ELK layout algorithms for automatic arrangement          |
| 5.9  | Export                 | Export diagram as PNG, SVG, or PDF                                |
| 5.10 | Minimap & zoom         | Minimap overlay, zoom controls, fit-to-screen                     |

### Dependencies on Prior Phases

- Phase 2 (schema introspection for reverse engineering).

### Acceptance Criteria

- [ ] Opening ERD view on `test_db` renders all tables with correct columns.
- [ ] Foreign key relationships display as connecting lines between table nodes.
- [ ] Creating a new table in the ERD and applying generates valid `CREATE TABLE` DDL.
- [ ] Adding a column to an existing table generates `ALTER TABLE ADD COLUMN`.
- [ ] Auto-layout arranges 20 tables without overlapping.
- [ ] Export as PNG produces a high-resolution image of the diagram.
- [ ] Schema diff between two states generates correct `ALTER` statements.
- [ ] Undo/redo works for all ERD operations.

### Risk Factors

| Risk                                    | Impact | Mitigation                                                  |
| --------------------------------------- | ------ | ----------------------------------------------------------- |
| React Flow performance with 100+ tables | Medium | Virtualize off-screen nodes, simplify rendering at low zoom |
| DDL generation edge cases               | High   | Exhaustive tests for all MySQL DDL features                 |
| Layout algorithm aesthetics             | Low    | Allow manual positioning, save positions per schema         |

---

## Phase 6: Database Administration

**Goal:** Users can manage users, processes, server settings, and perform maintenance and backup/restore operations.

### Key Deliverables

#### Backend (Rust — `mas-admin`)

| #   | Deliverable                | Details                                                          |
| --- | -------------------------- | ---------------------------------------------------------------- |
| 6.1 | User/role management       | `CREATE USER`, `ALTER USER`, `DROP USER`, `GRANT`, `REVOKE`      |
| 6.2 | Process list monitoring    | `SHOW PROCESSLIST` with periodic refresh                         |
| 6.3 | Server variable management | `SHOW VARIABLES`, `SET GLOBAL/SESSION`                           |
| 6.4 | Table maintenance          | `OPTIMIZE TABLE`, `REPAIR TABLE`, `ANALYZE TABLE`, `CHECK TABLE` |
| 6.5 | Backup orchestration       | Invoke `mysqldump` or custom `SELECT INTO OUTFILE` based export  |
| 6.6 | Restore from dump          | Stream SQL dump execution with progress tracking                 |
| 6.7 | Server status metrics      | `SHOW GLOBAL STATUS`, InnoDB metrics, replication status         |

#### Frontend (React)

| #    | Deliverable             | Details                                                            |
| ---- | ----------------------- | ------------------------------------------------------------------ |
| 6.8  | User management panel   | List users, create/edit/drop with privilege matrix                 |
| 6.9  | Process list            | Auto-refreshing table with "Kill" buttons                          |
| 6.10 | Server variables viewer | Searchable, filterable list; inline editing for settable variables |
| 6.11 | Maintenance wizard      | Select tables → select operation → run with progress               |
| 6.12 | Backup/restore wizard   | Step-by-step wizard with options, progress bar, log output         |
| 6.13 | Server dashboard        | Recharts-based charts for QPS, connections, buffer pool, etc.      |

### Dependencies on Prior Phases

- Phase 1 (connection manager, query execution).
- Phase 2 (schema introspection for table listing).

### Acceptance Criteria

- [ ] User management panel lists all MySQL users with their privileges.
- [ ] Creating a new user with specific privileges works and is verified by reconnecting as that user.
- [ ] Process list shows running queries and "Kill" terminates a target process.
- [ ] Server variables are searchable and editable (where MySQL allows).
- [ ] Table maintenance operations run with progress indication and completion status.
- [ ] Backup wizard produces a valid SQL dump that can be restored.
- [ ] Restore wizard imports a dump and shows progress.
- [ ] Server dashboard displays real-time metrics that update on a configurable interval.

### Risk Factors

| Risk                                              | Impact   | Mitigation                                                              |
| ------------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| Destructive operations (DROP USER, DROP DATABASE) | Critical | Confirmation dialogs with typed confirmation for destructive actions    |
| `mysqldump` not available on user's system        | Medium   | Bundle or provide download instructions; offer pure-SQL export fallback |
| Privilege escalation bugs                         | Critical | Validate all admin operations against current user's privileges first   |

---

## Phase 7: Import/Export & Data Tools

**Goal:** Users can import and export data in multiple formats with column mapping and streaming for large datasets.

### Key Deliverables

#### Backend (Rust — `mas-export`)

| #   | Deliverable           | Details                                                            |
| --- | --------------------- | ------------------------------------------------------------------ |
| 7.1 | CSV export/import     | Configurable delimiter, quote character, encoding, header row      |
| 7.2 | JSON export/import    | Array of objects or newline-delimited JSON                         |
| 7.3 | SQL export            | `INSERT` or `REPLACE` statements; batch size configurable          |
| 7.4 | Excel export          | XLSX via `rust_xlsxwriter`; sheet per table option                 |
| 7.5 | XML export            | Configurable root/row element names                                |
| 7.6 | Markdown export       | GitHub-flavored Markdown tables                                    |
| 7.7 | Column mapping engine | Map source columns to target columns with type coercion            |
| 7.8 | Streaming export      | Write directly to file in chunks; support datasets larger than RAM |

#### Frontend (React)

| #    | Deliverable       | Details                                                               |
| ---- | ----------------- | --------------------------------------------------------------------- |
| 7.9  | Export wizard     | Format selection → options → preview → export with progress           |
| 7.10 | Import wizard     | File selection → format detection → column mapping → preview → import |
| 7.11 | Progress bars     | Real-time progress for long-running import/export operations          |
| 7.12 | Data compare tool | Side-by-side comparison of data between two connections/databases     |

### Dependencies on Prior Phases

- Phase 1 (connection, query execution).
- Phase 3 (data type handling for correct serialization).

### Acceptance Criteria

- [ ] Exporting 100K rows to CSV completes in under 10 seconds.
- [ ] Exported CSV is valid and can be re-imported with the same column mapping.
- [ ] JSON export produces valid JSON; import correctly maps keys to columns.
- [ ] SQL export generates valid INSERT/REPLACE statements that execute without errors.
- [ ] XLSX export creates a readable Excel file with correct data types per column.
- [ ] Column mapping UI allows remapping, skipping, and default values.
- [ ] Streaming export of a 5M-row table does not exceed 200MB RAM.
- [ ] Import wizard shows a preview of the first 100 rows before committing.
- [ ] Progress bar updates in real-time during long operations.

### Risk Factors

| Risk                                       | Impact | Mitigation                                                 |
| ------------------------------------------ | ------ | ---------------------------------------------------------- |
| Memory pressure with large exports         | High   | Streaming writes, never buffer entire dataset              |
| Character encoding issues (UTF-8, Latin-1) | Medium | Auto-detect encoding on import; default to UTF-8 on export |
| Excel format limitations (1M row limit)    | Low    | Warn user; offer to split across sheets                    |

---

## Phase 8: Performance Monitoring & Query Analysis

**Goal:** Users can monitor server performance in real-time and analyze query performance.

### Key Deliverables

#### Backend (Rust — `mas-core`)

| #   | Deliverable            | Details                                                       |
| --- | ---------------------- | ------------------------------------------------------------- |
| 8.1 | Real-time metrics      | `SHOW GLOBAL STATUS` polling; compute deltas for rate metrics |
| 8.2 | Slow query log parser  | Parse slow query log file or `performance_schema`             |
| 8.3 | EXPLAIN analyzer       | Execute `EXPLAIN FORMAT=JSON`, parse into structured model    |
| 8.4 | Index usage statistics | `sys.schema_unused_indexes`, `sys.schema_index_statistics`    |
| 8.5 | Table size tracking    | `INFORMATION_SCHEMA.TABLES` → data_length, index_length       |

#### Frontend (React)

| #    | Deliverable           | Details                                                                   |
| ---- | --------------------- | ------------------------------------------------------------------------- |
| 8.6  | Real-time dashboard   | Auto-refreshing charts (QPS, connections, buffer pool hit ratio, threads) |
| 8.7  | Slow query viewer     | Sortable list of slow queries with execution plans                        |
| 8.8  | Visual EXPLAIN        | Tree visualization of EXPLAIN output with cost annotations                |
| 8.9  | Index recommendations | Suggested indexes based on slow queries and unused index analysis         |
| 8.10 | Table size chart      | Bar/treemap chart showing relative table sizes                            |

### Dependencies on Prior Phases

- Phase 1 (connection, query execution).
- Phase 2 (schema introspection).

### Acceptance Criteria

- [ ] Dashboard shows live QPS, connection count, and buffer pool metrics.
- [ ] Metrics update every 1 second without noticeable UI lag.
- [ ] Slow query viewer lists queries from `performance_schema.events_statements_summary_by_digest`.
- [ ] Visual EXPLAIN renders a tree for a multi-table JOIN query.
- [ ] Index recommendations suggest missing indexes based on query patterns.
- [ ] Table size chart accurately reflects `data_length + index_length`.

### Risk Factors

| Risk                                        | Impact | Mitigation                                                   |
| ------------------------------------------- | ------ | ------------------------------------------------------------ |
| `performance_schema` not enabled            | Medium | Fall back to `SHOW STATUS`; document requirement             |
| High-frequency polling impacts server       | Medium | Configurable interval (min 1s), disable when tab not visible |
| EXPLAIN output varies across MySQL versions | Medium | Handle both traditional and JSON formats                     |

---

## Phase 9: Polish, Accessibility & Release

**Goal:** Production-ready application with keyboard shortcuts, themes, accessibility, auto-update, and release packaging.

### Key Deliverables

| #    | Deliverable              | Details                                                                             |
| ---- | ------------------------ | ----------------------------------------------------------------------------------- |
| 9.1  | Keyboard shortcut system | Customizable shortcuts; default set for common actions                              |
| 9.2  | Command palette          | `cmdk`-based palette (Cmd+K / Ctrl+K) for quick action access                       |
| 9.3  | Onboarding tutorial      | First-launch tutorial highlighting key features                                     |
| 9.4  | Theme system             | Dark/light built-in themes; custom theme support via CSS variables                  |
| 9.5  | Accessibility audit      | ARIA roles, keyboard navigation for all interactive elements, screen reader testing |
| 9.6  | Cross-platform testing   | Dedicated testing pass on Windows, macOS, Linux                                     |
| 9.7  | Auto-update              | Tauri updater plugin with update notification and one-click install                 |
| 9.8  | Crash reporting          | Capture Rust panics and JS errors; optional anonymous reporting                     |
| 9.9  | Documentation site       | User guide and API reference (Docusaurus or similar)                                |
| 9.10 | Release packaging        | Windows (MSI + NSIS), macOS (DMG), Linux (AppImage, .deb, .rpm)                     |

### Dependencies on Prior Phases

- All prior phases (0–8) should be feature-complete.

### Acceptance Criteria

- [ ] All common actions are accessible via keyboard shortcuts.
- [ ] Command palette can find and execute any action by name.
- [ ] Theme switching applies instantly across all components.
- [ ] WCAG 2.1 AA compliance for all interactive elements.
- [ ] Screen reader (VoiceOver, NVDA) can navigate all major features.
- [ ] Auto-update detects and installs a new version on all three platforms.
- [ ] Crash report captures stack trace and app state without PII.
- [ ] Release builds pass smoke tests on Windows 10/11, macOS 13+, Ubuntu 22.04+.
- [ ] All installers (MSI, DMG, AppImage, deb, rpm) install and launch successfully.

### Risk Factors

| Risk                                    | Impact | Mitigation                                                   |
| --------------------------------------- | ------ | ------------------------------------------------------------ |
| Accessibility retrofitting is expensive | High   | Follow ARIA best practices from Phase 0; audit incrementally |
| Code signing certificates required      | Medium | Budget for Apple Developer + Windows EV certificates         |
| Auto-update security (MITM)             | High   | Tauri updater uses signature verification by default         |

---

## Phase 10: Beta & Community

**Goal:** Public beta release, community feedback loop, and preparation for long-term sustainability.

### Key Deliverables

| #    | Deliverable            | Details                                                                |
| ---- | ---------------------- | ---------------------------------------------------------------------- |
| 10.1 | Public beta release    | Publish on GitHub Releases, website, and package managers              |
| 10.2 | Bug bounty program     | Define scope, severity tiers, and reward structure                     |
| 10.3 | Community feedback     | GitHub Discussions, Discord/Slack community, feedback forms            |
| 10.4 | Performance benchmarks | Published benchmark suite comparing against MySQL Workbench, DBeaver   |
| 10.5 | Plugin API spec        | Define extension points: custom exporters, AI providers, themes        |
| 10.6 | Contribution docs      | CONTRIBUTING.md, architecture guide, code style guide, issue templates |

### Dependencies on Prior Phases

- Phase 9 complete (production-quality release).

### Acceptance Criteria

- [ ] Beta release is downloadable and installable on all three platforms.
- [ ] Bug bounty program is documented and published.
- [ ] Community channels are active and monitored.
- [ ] Benchmark results are reproducible and published.
- [ ] Plugin API specification is documented with at least one example plugin.
- [ ] A new contributor can set up the dev environment and submit a PR by following CONTRIBUTING.md.

### Risk Factors

| Risk                                      | Impact | Mitigation                                         |
| ----------------------------------------- | ------ | -------------------------------------------------- |
| Low community adoption                    | Medium | Marketing, comparison articles, demo videos        |
| Security vulnerabilities reported in beta | High   | Rapid response process, security advisory workflow |
| Plugin API design too rigid/too loose     | Medium | Start minimal, iterate based on feedback           |

---

## Phase Dependency Graph

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3
                │            │            │
                │            ├──► Phase 5  │
                │            │            │
                ├──► Phase 4 (needs 1+2)  │
                │                         │
                ├──► Phase 6 (needs 1+2)  │
                │                         │
                ├──► Phase 7 (needs 1+3) ◄┘
                │
                └──► Phase 8 (needs 1+2)

Phase 9 ◄── All phases (0–8) feature-complete

Phase 10 ◄── Phase 9 complete
```

> **Phases 4–8 can be developed in parallel** once their dependencies are met.

---

## Timeline Estimate

| Phase                    | Estimated Duration | Parallelizable With |
| ------------------------ | ------------------ | ------------------- |
| 0                        | 1–2 weeks          | —                   |
| 1                        | 3–4 weeks          | —                   |
| 2                        | 2–3 weeks          | —                   |
| 3                        | 3–4 weeks          | —                   |
| 4                        | 3–4 weeks          | 5, 6, 7, 8          |
| 5                        | 3–4 weeks          | 4, 6, 7, 8          |
| 6                        | 3–4 weeks          | 4, 5, 7, 8          |
| 7                        | 2–3 weeks          | 4, 5, 6, 8          |
| 8                        | 2–3 weeks          | 4, 5, 6, 7          |
| 9                        | 3–4 weeks          | —                   |
| 10                       | 2–3 weeks          | —                   |
| **Total (serial)**       | **~28–38 weeks**   |                     |
| **Total (parallel 4–8)** | **~18–24 weeks**   |                     |
