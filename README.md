<p align="center">
  <img src="docs/assets/logo.png" alt="SQLPilot" width="120" />
</p>

<h1 align="center">SQLPilot</h1>

<p align="center">
  <strong>A blazing-fast MySQL GUI — built with Rust &amp; React.</strong><br />
  <em>Think MySQL Workbench, but actually good.</em>
</p>

<p align="center">
  <a href="#-features">Features</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-development">Development</a> •
  <a href="#-tech-stack">Tech Stack</a> •
  <a href="#-project-structure">Structure</a> •
  <a href="#-contributing">Contributing</a> •
  <a href="#-license">License</a>
</p>

<p align="center">
  <a href="https://www.buymeacoffee.com/evworth"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="40" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
  <img src="https://img.shields.io/badge/rust-1.75%2B-orange" alt="Rust" />
  <img src="https://img.shields.io/badge/node-20%2B-brightgreen" alt="Node.js" />
  <img src="https://img.shields.io/badge/tests-1488%2B%20passing-brightgreen" alt="Tests" />
</p>

---

SQLPilot is a modern, open-source, cross-platform MySQL database management tool. It combines a Rust backend (via [Tauri 2](https://v2.tauri.app/)) with a React frontend to deliver native desktop performance in a **~22 MB binary** — no Electron bloat, no JVM overhead.

**Why this over MySQL Workbench, DBeaver, or SQLyog?**

- ⚡ **Instant startup** — native binary, not Java
- 🪶 **Tiny footprint** — ~22 MB vs 300+ MB for Workbench
- 🎯 **Covers the most-used SQLyog features** — everything you need, nothing you don't
- 🔓 **Fully open source** — MIT licensed, no telemetry, no paywalls

## ✨ Features

### SQL Editor

- **Monaco Editor** — the same editor engine as VS Code
- **Schema-aware autocomplete** — suggests tables after `FROM`, columns after `SELECT`, databases after `USE`, plus 90+ MySQL keywords and 40+ functions
- **SQL formatting** — one-click beautify with `Ctrl+Shift+F`
- **Find & replace** — `Ctrl+F` / `Ctrl+H` with Monaco's built-in search
- **Multi-tab editor** — drag to reorder, middle-click to close, double-click to rename, unsaved indicators
- **Query execution** — `Ctrl+Enter` or `F5`, multi-statement support with result tabs

### Results Grid

- **Sortable columns** with click-to-sort headers
- **Inline cell editing** — double-click to edit, generates `UPDATE`/`INSERT`/`DELETE` statements with primary key detection
- **Export** — Copy, CSV, JSON, SQL, Markdown with one click
- **Right-click context menus** — copy cell, copy row, copy as INSERT statement

### Schema Browser

- **Full object tree** — databases → tables, views, procedures, functions, triggers
- **Table structure viewer** — columns, indexes, and DDL in a tabbed panel
- **Context menus** — SELECT top 100, view structure, copy name, drop, design table
- **Double-click actions** — tables open data, procedures open the viewer/executor

### Visual Tools

- **Table Designer** — create and alter tables with a visual form: column editor, index editor, foreign key editor, table options, DDL preview
- **EXPLAIN Visualizer** — color-coded execution plan with cost bars, access type legend, and tree view for `EXPLAIN ANALYZE`

### Database Administration

- **Process list** — auto-refreshing with time color-coding and kill process button
- **Server variables** — searchable, grouped by category, copy-to-clipboard
- **Server status** — metric cards (uptime, QPS, connections, buffer pool, threads, slow queries)
- **User management** — list users, view/edit privileges with checkbox grid, create/drop users, change passwords

### Backup & Restore

- **Backup** — full SQL dump with options: structure only/data only/both, DROP TABLE, multi-row INSERTs, views/procedures/triggers inclusion, progress tracking
- **Restore** — SQL file execution with progress bar and error reporting

### Schema Comparison

- **Cross-connection diff** — compare schemas across different servers
- **Color-coded results** — green (added), red (removed), yellow (modified), grey (identical)
- **Column-level detail** — see exactly what changed: type, nullable, default, etc.
- **Sync SQL generation** — generate `CREATE`/`ALTER`/`DROP` statements to synchronize, with selective execution

### Import & Export

- **SQL import** — execute `.sql` files with statement splitting and progress tracking
- **CSV import** — configurable delimiter, header detection, column mapping to target tables, batch INSERTs
- **Export formats** — CSV, JSON, SQL (`INSERT` statements), Markdown

### Connection Management

- **Connection profiles** — save, test, color-code, and label connections
- **SSL/TLS** — configurable SSL mode (disabled → verify identity), CA cert, client cert/key
- **SSH tunnels** — host, port, username, password or key file authentication
- **Environment labels** — tag connections as Development, Staging, or Production
- **Production safety** — confirmation dialogs before running `DROP`/`DELETE`/`TRUNCATE` on production

### Query Management

- **Query history** — every execution recorded with timestamp, duration, row count, status; searchable and click-to-reload
- **Query favorites** — save queries with name, category, and description; organized in folders
- **Stored procedure/function viewer** — auto-detect parameters, execute with input form, display results

### UX & Polish

- **Dark & light themes** — toggle with one click, or follow system preference; Monaco editor theme syncs automatically
- **Keyboard shortcuts** — `Ctrl+N` new tab, `Ctrl+W` close, `Ctrl+Tab` cycle, `F1` shortcuts help, `F5` execute, and more
- **Color-coded tabs** — connection color stripe on every tab for quick identification
- **Structured logging** — multi-layer tracing (console + rolling JSON file), all commands instrumented, passwords redacted

## 🚀 Quick Start

### Download

Pre-built binaries are available on the [Releases](https://github.com/EVWorth/sqlpilot/releases) page for:

- **Windows** — `.msi` installer, NSIS setup `.exe`, or portable `.exe`
- **macOS** — `.dmg` (Intel + Apple Silicon)
- **Linux** — `.deb`, `.AppImage`, `.rpm`

### First Launch

1. Download and install for your platform
2. Open SQLPilot
3. Click **+ New Connection** and enter your MySQL server details
4. Configure SSL or SSH tunnel if needed (tabs in the connection dialog)
5. Click **Test Connection** to verify, then **Save**
6. Double-click the connection to connect and start querying!

## 🛠️ Development

### Prerequisites

| Tool                              | Version | Purpose                     |
| --------------------------------- | ------- | --------------------------- |
| [Rust](https://rustup.rs/)        | 1.75+   | Backend compilation         |
| [Node.js](https://nodejs.org/)    | 20+     | Frontend tooling            |
| [Docker](https://www.docker.com/) | 24+     | Integration test containers |

**Linux/WSL system dependencies** (for Tauri desktop builds):

```bash
sudo apt install -y pkg-config libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libssl-dev
```

### Setup

```bash
# Clone the repository
git clone https://github.com/EVWorth/sqlpilot.git
cd sqlpilot

# One-command setup (installs system deps + npm deps + checks Rust)
make setup

# Or manually:
npm install
```

### Running

```bash
# Full desktop app (native window via Tauri)
make dev
# or: npx tauri dev

# Web preview in browser (no system deps needed, great for UI work)
make dev-web
# Then open http://localhost:1420
```

**Desktop shortcut:** Double-click "SQLPilot (Dev)" on your desktop. It shows a progress
dialog while compiling, then opens the app window automatically.

### Testing

```bash
# Run everything
make test

# Frontend unit tests (1488 tests — stores, parsers, generators, diff engine)
make test-frontend
# or: npx vitest run

# Rust integration tests against Docker MySQL 8 (45 tests)
make db-up          # Start MySQL 8 on port 13306
make test-rust
# or: cd src-tauri && cargo test -p mas-core -p mas-export -p mas-admin

# Type checking
npx tsc --noEmit                    # TypeScript
cd src-tauri && cargo clippy         # Rust
```

### Building for Production

```bash
# Build optimized desktop binary
npx tauri build

# Output:
#   src-tauri/target/release/bundle/
#     ├── msi/        (Windows .msi installer)
#     ├── nsis/       (Windows NSIS setup)
#     ├── deb/        (Linux .deb)
#     └── appimage/   (Linux .AppImage)
```

### Release & Auto-Update

Tagging a commit with `v*` triggers the release workflow in CI, which builds binaries and generates a signed update manifest.

**To set up update signing (one-time):**

```bash
# Generate a signing key pair (keep the private key secret!)
npx tauri signer generate -w ~/.tauri/sqlpilot-updater.key

# Add the private key as a GitHub secret:
#   Name: TAURI_SIGNING_PRIVATE_KEY
#   Value: contents of ~/.tauri/sqlpilot-updater.key

# Store the public key securely — it's already in tauri.conf.json
cat ~/.tauri/sqlpilot-updater.key.pub
```

The `TAURI_SIGNING_PRIVATE_KEY` secret must exist for the `generate-update-manifest` job to succeed. Without it, releases will build but the update manifest won't be signed.

### Make Commands

| Command              | Description                                     |
| -------------------- | ----------------------------------------------- |
| `make dev`           | Run desktop app in development mode             |
| `make dev-web`       | Run browser preview on `localhost:1420`         |
| `make build`         | Build production desktop binary                 |
| `make test`          | Run all tests (Rust + frontend)                 |
| `make test-rust`     | Run Rust integration tests against Docker MySQL |
| `make test-frontend` | Run frontend unit tests (Vitest)                |
| `make lint`          | Run clippy + TypeScript type checking           |
| `make db-up`         | Start MySQL 8 Docker container (port 13306)     |
| `make db-down`       | Stop and remove test containers                 |
| `make db-reset`      | Restart containers fresh                        |
| `make setup`         | Install all dependencies                        |

### Environment Variables

```bash
# Optional: Override log level (default: info for console, debug for file)
RUST_LOG=debug
```

## 🏗️ Tech Stack

### Frontend

| Technology                                                          | Purpose                                         |
| ------------------------------------------------------------------- | ----------------------------------------------- |
| [React 18](https://react.dev/)                                      | UI framework                                    |
| [TypeScript](https://www.typescriptlang.org/)                       | Type safety                                     |
| [Vite](https://vitejs.dev/)                                         | Build tooling and HMR                           |
| [Monaco Editor](https://microsoft.github.io/monaco-editor/)         | SQL editor (same engine as VS Code)             |
| [TanStack Table v8](https://tanstack.com/table)                     | Data grid with sorting and virtualization       |
| [Zustand](https://zustand-demo.pmnd.rs/)                            | Lightweight state management (7 stores)         |
| [Tailwind CSS](https://tailwindcss.com/)                            | Utility-first styling with CSS variable theming |
| [sql-formatter](https://github.com/sql-formatter-org/sql-formatter) | SQL beautification                              |
| [Lucide React](https://lucide.dev/)                                 | Icon library                                    |

### Backend (Rust)

| Technology                                       | Purpose                                       |
| ------------------------------------------------ | --------------------------------------------- |
| [Tauri 2.0](https://v2.tauri.app/)               | Desktop app framework (WebView, not Electron) |
| [sqlx](https://github.com/launchbadge/sqlx)      | Async MySQL driver with connection pooling    |
| [tokio](https://tokio.rs/)                       | Async runtime                                 |
| [rusqlite](https://github.com/rusqlite/rusqlite) | Local SQLite for connection profile storage   |
| [tracing](https://docs.rs/tracing/)              | Structured logging with JSON file output      |
| [serde](https://serde.rs/)                       | Serialization / deserialization               |
| [DashMap](https://docs.rs/dashmap/)              | Thread-safe concurrent connection registry    |
| [rfd](https://docs.rs/rfd/)                      | Native file dialogs                           |

### Testing

| Technology                                     | Purpose                                                |
| ---------------------------------------------- | ------------------------------------------------------ |
| [Vitest](https://vitest.dev/)                  | Frontend unit tests (1488 tests)                       |
| [cargo test](https://doc.rust-lang.org/cargo/) | Rust integration tests against Docker MySQL (45 tests) |
| [Docker](https://www.docker.com/)              | MySQL 8, MySQL 5.7, MariaDB 11 test containers         |

## 📁 Project Structure

```
sqlpilot/
├── src/                           # React frontend
│   ├── components/                #   46 UI components
│   │   ├── admin/                 #     AdminPanel, UserManagement, CreateUser, ChangePassword
│   │   ├── ai/                    #     AIChatPanel, ChatMessage, ModeSelector, ToolCallBlock
│   │   ├── backup/                #     BackupDialog, RestoreDialog
│   │   ├── common/                #     ContextMenu, ConfirmDialog, ShortcutsDialog
│   │   ├── compare/               #     SchemaCompare, SyncPreview
│   │   ├── connection/            #     ConnectionDialog (General, SSL, SSH, Advanced tabs)
│   │   ├── designer/              #     TableDesigner, SQLPreviewDialog
│   │   ├── editor/                #     SQLEditor, EditorTabs, QueryToolbar
│   │   ├── explain/               #     ExplainPanel (table view + tree view)
│   │   ├── favorites/             #     QueryFavorites, SaveFavoriteDialog
│   │   ├── grid/                  #     ResultsGrid, EditableCell, EditToolbar
│   │   ├── history/               #     QueryHistory
│   │   ├── import/                #     ImportDialog (CSV + SQL modes)
│   │   ├── layout/                #     AppLayout, Sidebar, MainPanel, Toolbar, StatusBar
│   │   ├── routine/               #     RoutineViewer (procedure/function executor)
│   │   └── schema/                #     TableStructure (columns, indexes, DDL)
│   ├── hooks/                     #   7 custom hooks (context menu, keyboard, theme, schema cache, grid editing, query execution, click handler)
│   ├── lib/                       #   Tauri IPC bridge, SQL generators, parsers, diff engine
│   ├── stores/                    #   8 Zustand stores (connection, editor, result, history, favorites, ai, theme, settings)
│   ├── types/                     #   TypeScript type definitions
│   └── styles/                    #   Dark + light theme CSS variables
├── src-tauri/                     # Rust backend
│   ├── src/
│   │   ├── commands/              #   Tauri IPC command handlers
│   │   └── lib.rs                 #   App state, tracing init, command registration
│   ├── crates/
│   │   ├── mas-core/              #   Connection manager, query executor, schema inspector
│   │   ├── mas-sqlite/            #   SQLite wrapper for connection profile + history storage
│   │   ├── mas-ai/                #   AI service (Copilot SDK integration)
│   │   ├── mas-export/            #   CSV, JSON, SQL, Markdown exporters
│   │   └── mas-admin/             #   Process list, server variables, kill process
│   ├── Cargo.toml                 #   Workspace with shared dependencies
│   └── tauri.conf.json            #   Tauri app configuration
├── tests/fixtures/sql/            # Test seed data (tables, views, procedures, triggers)
├── docs/design/                   # Design documentation
│   ├── ARCHITECTURE.md            #   System architecture
│   ├── DESIGN_REQUIREMENTS.md     #   Requirements & competitive analysis
│   ├── TESTING_STRATEGY.md        #   Test strategy & coverage
│   └── TECH_DECISIONS.md          #   Architecture Decision Records
├── docker-compose.test.yml        # MySQL 8 (13306), MySQL 5.7 (13307), MariaDB 11 (13308)
├── Makefile                       # Dev commands
└── package.json                   # Frontend dependencies
```

## 🤝 Contributing

We welcome contributions! Here's how to get started:

1. **Fork** the repository and create a feature branch from `main`
2. **Set up** the dev environment: `make setup`
3. **Make your changes** with clear, focused commits
4. **Test** your changes: `make test && make lint`
5. **Submit a pull request** with a clear description of what and why

### Guidelines

- Follow existing code style — run `cargo clippy` and `npx tsc --noEmit` before submitting
- Write tests for new features and bug fixes
- Keep PRs focused — one feature or fix per PR
- Update documentation for user-facing changes

### Areas We'd Love Help With

- 🧪 More integration tests for edge cases
- 🌍 Internationalization (i18n)
- ♿ Accessibility improvements
- 📱 Mobile-responsive layout
- 🗄️ PostgreSQL / SQLite adapter support
- 📊 Query plan visualization improvements
- 🔌 Plugin system for custom extensions

## 🙏 Acknowledgements

Built on top of these excellent open-source projects:

- [Tauri](https://tauri.app/) — desktop app framework
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — code editor
- [TanStack Table](https://tanstack.com/table) — headless table library
- [sqlx](https://github.com/launchbadge/sqlx) — async SQL toolkit for Rust
- [Zustand](https://zustand-demo.pmnd.rs/) — state management
- [Lucide](https://lucide.dev/) — icon library

Inspired by the best features of [SQLyog](https://github.com/nickyat/sqlyog-community), [DBeaver](https://github.com/dbeaver/dbeaver), and [MySQL Workbench](https://www.mysql.com/products/workbench/) — with none of their baggage.

## 📄 License

This project is licensed under the [MIT License](LICENSE).

---

<p align="center">
  Made with ❤️ and 🦀<br />
  <strong>SQLPilot</strong> — because your database tool shouldn't be the slowest thing in your stack.
</p>
