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
  <a href="#-tech-stack">Tech Stack</a> •
  <a href="#-contributing">Contributing</a> •
  <a href="#-license">License</a>
</p>

<p align="center">
  <a href="https://www.buymeacoffee.com/evworth"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="40" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
  <img src="https://img.shields.io/badge/rust-1.95-orange" alt="Rust" />
  <img src="https://img.shields.io/badge/node-24%2B-brightgreen" alt="Node.js" />
</p>

---

SQLPilot is a modern, open-source, cross-platform MySQL database management tool. It combines a Rust backend (via [Tauri 2](https://v2.tauri.app/)) with a React frontend to deliver native desktop performance in a small binary — no Electron bloat, no JVM overhead. It works with MySQL 8 and MariaDB 11, and can also open local SQLite files.

**Why this over MySQL Workbench, DBeaver, or SQLyog?**

- ⚡ **Instant startup** — native binary, not Java
- 🪶 **Small footprint** — the OS webview instead of a bundled browser or JVM
- 🎯 **Covers the most-used SQLyog features** — everything you need, nothing you don't
- 🔓 **Fully open source** — MIT licensed, no telemetry, no paywalls

## ✨ Features

### SQL Editor

- **Monaco Editor** — the same editor engine as VS Code
- **Schema-aware autocomplete** — suggests tables after `FROM`, columns after `SELECT`, databases after `USE`, plus MySQL keywords and functions
- **SQL formatting** — one-click beautify with `Ctrl+Shift+F`
- **Find & replace** — `Ctrl+F` / `Ctrl+H` with Monaco's built-in search
- **Multi-tab editor** — drag to reorder, middle-click to close, double-click to rename, unsaved indicators
- **Query execution** — `Ctrl+Enter` or `F9` for the statement at the cursor, `Ctrl+Shift+Enter` for all; multi-statement support with result tabs; `Ctrl+.` cancels

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

### Import & Export

- **SQL import** — execute `.sql` files with statement splitting and progress tracking
- **CSV import** — configurable delimiter, header detection, column mapping to target tables, batch INSERTs
- **Export formats** — CSV, JSON, SQL (`INSERT` statements), Markdown

### Connection Management

- **Connection profiles** — save, test, color-code, and label connections
- **SSL/TLS** — configurable SSL mode (disabled → verify identity), CA cert, client cert/key
- **Environment labels** — tag connections as Development, Staging, or Production
- **Production safety** — confirmation dialogs before running `DROP`/`DELETE`/`TRUNCATE` and other destructive statements on production
- **Read-only connections** — enforced in the backend, not just the UI
- **SQLite files** — open a local SQLite database file and browse and query it in the same panes

SSH tunnelling is not supported yet: a profile configured for a tunnel is refused rather than connected directly.

### Query Management

- **Query history** — every execution recorded with timestamp, duration, row count, status; searchable and click-to-reload
- **Query favorites** — save queries with name, category, and description; organized in folders
- **Stored procedure/function viewer** — auto-detect parameters, execute with input form, display results

### Agents — bring your own

SQLPilot never calls a model, never holds an API key, and never signs in for
you. It exposes your databases to the agent CLI you already have, on terms you
set, over the [Model Context Protocol](https://modelcontextprotocol.io).

- **Your harness, your account** — [Claude Code](https://claude.com/claude-code)
  and [GitHub Copilot CLI](https://github.com/github/copilot-cli) run inside the
  app, logged in as you. Any other MCP client can use the same endpoint from a
  terminal or an editor
- **Nothing is shared until you share it** — per connection, with a posture:
  schema only, samples, or full, and optionally for one database out of
  twenty
- **Writes are approved in SQLPilot's window** — the statement runs inside a
  transaction that is not committed, so the question you answer says _4,213
  rows_, not _some rows_. Saying no rolls it back. No harness flag, `--yolo`
  included, can skip this
- **Schema changes are refused on production** unless you unlock that
  connection, because a server commits before a schema change and there is
  nothing to roll back
- **Credential columns never leave** — `password`, `api_key`, `ssn` and the
  rest return no values at any posture, in queries, profiles, or the grid the
  agent is reading over your shoulder
- **It can see what you are looking at** — the statement in the editor, the
  result underneath it, the error you just hit — and offers changes as a
  **diff you accept, reject, or edit first**
- **The endpoint is loopback-only**, behind a bearer token you can rotate, and
  refuses anything a browser sent

### UX & Polish

- **Dark & light themes** — toggle with one click, or follow system preference; Monaco editor theme syncs automatically
- **Keyboard shortcuts** — `Ctrl+N` new tab, `Ctrl+W` close, `Ctrl+Tab` cycle, `F1` shortcuts help, `F9` execute, `F5` refresh schema, and more
- **Color-coded tabs** — connection color stripe on every tab for quick identification
- **Structured logging** — console plus a daily JSON log file in the app data folder; connection passwords are never logged

## 🚀 Quick Start

### Download

Pre-built binaries are available on the [Releases](https://github.com/EVWorth/sqlpilot/releases) page for:

- **Windows** — `.msi` installer, NSIS setup `.exe`, or portable `.exe`
- **macOS** — `.dmg` (Intel + Apple Silicon)
- **Linux** — `.deb`, `.AppImage`, `.rpm`

### First Launch

1. Download and install for your platform
2. Open SQLPilot
3. Click **Connect** in the connection bar, then **New Connection…**, and enter your MySQL or MariaDB server details
4. Configure SSL if needed (a tab in the connection dialog)
5. Click **Test Connection** to verify, then **Save**
6. Pick the profile from the **Connect** list to connect and start querying

## 🏗️ Tech Stack

**Frontend:** [React 19](https://react.dev/), [TypeScript](https://www.typescriptlang.org/),
[Vite](https://vitejs.dev/), [Monaco Editor](https://microsoft.github.io/monaco-editor/),
[TanStack Table](https://tanstack.com/table) and TanStack Virtual,
[Zustand](https://zustand-demo.pmnd.rs/), [Tailwind CSS](https://tailwindcss.com/),
[sql-formatter](https://github.com/sql-formatter-org/sql-formatter),
[Lucide](https://lucide.dev/).

**Backend (Rust):** [Tauri 2](https://v2.tauri.app/), [sqlx](https://github.com/launchbadge/sqlx)
for MySQL/MariaDB, [tokio](https://tokio.rs/), [rusqlite](https://github.com/rusqlite/rusqlite)
for local storage and SQLite files, the OS credential store for passwords,
[rmcp](https://github.com/modelcontextprotocol/rust-sdk) for the agent endpoint,
[tracing](https://docs.rs/tracing/) for logs.

Architecture and design notes are indexed in [docs/README.md](docs/README.md).

## 🤝 Contributing

Contributions are welcome. Setup, tasks, tests and the PR workflow are in
[CONTRIBUTING.md](CONTRIBUTING.md).

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
