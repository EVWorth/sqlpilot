<p align="center">
  <img src="docs/assets/logo.png" alt="MySQL AI Studio" width="120" />
</p>

<h1 align="center">MySQL AI Studio</h1>

<p align="center">
  <strong>A blazing-fast, AI-powered MySQL GUI — built with Rust &amp; React.</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#screenshots">Screenshots</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#development">Development</a> •
  <a href="#tech-stack">Tech Stack</a> •
  <a href="#contributing">Contributing</a> •
  <a href="#license">License</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
  <img src="https://img.shields.io/badge/rust-1.75%2B-orange" alt="Rust" />
  <img src="https://img.shields.io/badge/node-20%2B-brightgreen" alt="Node.js" />
</p>

---

MySQL AI Studio is a modern, cross-platform MySQL database management tool designed to replace MySQL Workbench. It combines the raw speed of a Rust backend with a beautiful React frontend and AI-powered features to make working with MySQL databases faster, smarter, and more enjoyable.

## Features

### ⚡ Blazing Fast
Sub-second startup, virtualized data grids, and native performance powered by Rust and Tauri 2. No Electron bloat, no JVM overhead — just instant responsiveness.

### 🤖 AI-Powered SQL
Natural language to SQL generation, query optimization suggestions, schema documentation generation, and smart error resolution — all powered by GitHub Copilot and local LLMs via Ollama.

### ✏️ Modern SQL Editor
Monaco-based editor with IntelliSense, schema-aware autocomplete, syntax highlighting, multi-tab support, code snippets, and SQL formatting. Everything you love about VS Code, purpose-built for SQL.

### 🗺️ Visual Schema Designer
Drag-and-drop ERD creation, auto-generated diagrams from existing schemas, forward and reverse engineering, and export to PNG/SVG/PDF.

### 📊 Smart Data Grid
Virtualized rendering for millions of rows at 60fps. Inline editing, multi-column sorting, advanced filtering, and export to CSV, JSON, SQL, Excel, and Markdown.

### 🔌 Connection Manager
SSH tunneling, SSL/TLS, connection profiles with color-coding, connection pooling, auto-reconnect, and encrypted profile import/export.

### 📝 Query History & Favorites
Searchable, persistent query history with AI-powered categorization. Bookmark queries, organize in folders, and share across workstations.

### 📈 Performance Dashboard
Real-time server metrics, slow query log analysis, index usage statistics, visual EXPLAIN plans, and AI-driven index recommendations.

### 🛡️ Database Administration
User and role management, process list with kill capability, backup and restore, table maintenance, server configuration, and replication monitoring.

### 🖥️ Cross-Platform
Native look and feel on Windows, macOS, and Linux. Small binary size, minimal resource usage, and OS-level integration.

### 🎨 Themeable
Dark and light modes with full custom theme support. Clean, minimal chrome that maximizes your workspace.

### 📦 Import / Export
CSV, JSON, SQL, Excel, XML, and Markdown. Column mapping for imports, batch processing with progress tracking, and schema migration script generation.

## Screenshots

> 🚧 **Coming Soon** — The application is under active development. Screenshots will be added as the UI stabilizes.

| SQL Editor | Data Grid | Schema Designer |
|:-:|:-:|:-:|
| ![SQL Editor](docs/assets/screenshots/editor.png) | ![Data Grid](docs/assets/screenshots/datagrid.png) | ![Schema Designer](docs/assets/screenshots/erd.png) |

| Performance Dashboard | Connection Manager | AI Chat |
|:-:|:-:|:-:|
| ![Dashboard](docs/assets/screenshots/dashboard.png) | ![Connections](docs/assets/screenshots/connections.png) | ![AI Chat](docs/assets/screenshots/ai-chat.png) |

## Quick Start

### Download

Pre-built binaries are available on the [Releases](https://github.com/worthapenny/mysql-ai-studio/releases) page for:

- **Windows** — `.msi` installer or portable `.exe`
- **macOS** — `.dmg` (universal binary: Intel + Apple Silicon)
- **Linux** — `.deb`, `.AppImage`, `.rpm`

### First Launch

1. Download and install for your platform.
2. Open MySQL AI Studio.
3. Click **New Connection** and enter your MySQL server details.
4. Click **Test Connection** to verify, then **Save**.
5. Double-click the connection to connect and start querying.

## Development

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| [Rust](https://rustup.rs/) | 1.75+ | Backend compilation |
| [Node.js](https://nodejs.org/) | 20+ | Frontend tooling |
| [pnpm](https://pnpm.io/) | 9+ | Package manager |
| [Docker](https://www.docker.com/) | 24+ | MySQL test containers |

### Setup

```bash
# Clone the repository
git clone https://github.com/worthapenny/mysql-ai-studio.git
cd mysql-ai-studio

# Install frontend dependencies
pnpm install

# Start a MySQL test container
docker compose up -d mysql

# Run the development server (launches both Rust backend and React frontend)
pnpm tauri dev
```

### Useful Commands

```bash
# Run frontend unit tests
pnpm test

# Run backend unit tests
cargo test --manifest-path src-tauri/Cargo.toml

# Run E2E tests (requires running app)
pnpm test:e2e

# Lint and format
pnpm lint
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml

# Build for production
pnpm tauri build
```

### Environment Variables

Create a `.env` file in the project root for local development:

```env
# Optional: GitHub Copilot token for AI features
MYSQL_AI_STUDIO_COPILOT_TOKEN=your_token_here

# Optional: Ollama endpoint for local LLM support
MYSQL_AI_STUDIO_OLLAMA_URL=http://localhost:11434
```

## Tech Stack

### Frontend

| Technology | Purpose |
|------------|---------|
| [React 18](https://react.dev/) | UI framework |
| [TypeScript](https://www.typescriptlang.org/) | Type safety |
| [Vite](https://vitejs.dev/) | Build tooling and dev server |
| [TanStack Table v8](https://tanstack.com/table) | Virtualized data grids |
| [Monaco Editor](https://microsoft.github.io/monaco-editor/) | SQL code editor |
| [monaco-sql-languages](https://github.com/AmazonConnect/monaco-sql-languages) | SQL language support for Monaco |
| [Tailwind CSS](https://tailwindcss.com/) | Styling |
| [Zustand](https://zustand-demo.pmnd.rs/) | State management |

### Backend

| Technology | Purpose |
|------------|---------|
| [Rust](https://www.rust-lang.org/) | Systems programming language |
| [Tauri 2.0](https://v2.tauri.app/) | Desktop app framework |
| [sqlx](https://github.com/launchbadge/sqlx) | Async MySQL driver with compile-time query checks |
| [tokio](https://tokio.rs/) | Async runtime |
| [serde](https://serde.rs/) | Serialization / deserialization |

### AI Integration

| Technology | Purpose |
|------------|---------|
| [GitHub Copilot SDK](https://github.com/features/copilot) | Cloud AI features (NL-to-SQL, optimization, documentation) |
| [Ollama](https://ollama.ai/) | Local LLM support for offline/private environments |

### Testing & CI

| Technology | Purpose |
|------------|---------|
| [Vitest](https://vitest.dev/) | Frontend unit testing |
| [cargo test](https://doc.rust-lang.org/cargo/commands/cargo-test.html) | Backend unit testing |
| [Playwright](https://playwright.dev/) | End-to-end testing |
| [Docker](https://www.docker.com/) | MySQL test containers |
| [GitHub Actions](https://github.com/features/actions) | Cross-platform CI/CD |

## Project Structure

```
mysql-ai-studio/
├── src/                        # React frontend source
│   ├── components/             #   UI components
│   │   ├── editor/             #     SQL editor (Monaco)
│   │   ├── grid/               #     Data grid (TanStack Table)
│   │   ├── schema/             #     Schema browser & ERD
│   │   ├── connections/        #     Connection management
│   │   ├── dashboard/          #     Performance dashboard
│   │   └── ai/                 #     AI chat & suggestions
│   ├── hooks/                  #   Custom React hooks
│   ├── stores/                 #   Zustand state stores
│   ├── services/               #   Tauri IPC & API layer
│   ├── types/                  #   TypeScript type definitions
│   └── styles/                 #   Global styles & themes
├── src-tauri/                  # Rust backend source
│   ├── src/
│   │   ├── commands/           #   Tauri command handlers
│   │   ├── db/                 #   Database connection & query engine
│   │   ├── ai/                 #   AI/LLM integration
│   │   ├── ssh/                #   SSH tunnel management
│   │   ├── export/             #   Data export engines
│   │   └── admin/              #   Server administration
│   ├── Cargo.toml              #   Rust dependencies
│   └── tauri.conf.json         #   Tauri configuration
├── tests/                      # E2E tests (Playwright)
├── docs/                       # Documentation
│   ├── design/                 #   Design & requirements docs
│   └── assets/                 #   Images & screenshots
├── docker-compose.yml          # MySQL test containers
├── package.json                # Frontend dependencies
├── vite.config.ts              # Vite configuration
├── tailwind.config.ts          # Tailwind configuration
├── tsconfig.json               # TypeScript configuration
└── README.md                   # This file
```

## Contributing

We welcome contributions! Here's how to get started:

1. **Fork** the repository and create a feature branch from `main`.
2. **Set up** the development environment using the instructions above.
3. **Make your changes** with clear, focused commits.
4. **Test** your changes — run `pnpm test`, `cargo test`, and manual QA.
5. **Submit a pull request** with a clear description of what and why.

### Guidelines

- Follow existing code style. Run `pnpm lint` and `cargo clippy` before submitting.
- Write tests for new features and bug fixes.
- Keep PRs focused — one feature or fix per PR.
- Update documentation for user-facing changes.
- Be respectful and constructive in discussions.

For more details, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Acknowledgements

Built with these outstanding open-source projects:

- [Tauri](https://tauri.app/) — desktop app framework
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — code editor
- [TanStack Table](https://tanstack.com/table) — headless table library
- [sqlx](https://github.com/launchbadge/sqlx) — async SQL toolkit for Rust

## License

This project is licensed under the [MIT License](LICENSE).

---

<p align="center">
  Made with ❤️ and 🦀 by the MySQL AI Studio contributors.
</p>
