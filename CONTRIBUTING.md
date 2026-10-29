# Contributing to SQLPilot

How to set up a development environment, run the app and the tests, and get a
change merged. Design and reference docs are indexed in
[docs/README.md](docs/README.md).

## Prerequisites

Toolchain versions live in `.node-version`, `rust-toolchain.toml` and
`mise.toml`, which rustup, CI and mise all read.

| Tool                              | Version                   | Purpose                              |
| --------------------------------- | ------------------------- | ------------------------------------ |
| [Rust](https://rustup.rs/)        | per `rust-toolchain.toml` | Backend                              |
| [Node.js](https://nodejs.org/)    | 24 (`.node-version`)      | Frontend tooling                     |
| [just](https://just.systems/)     | any recent                | Task runner (installed by mise)      |
| [Docker](https://www.docker.com/) | with Compose              | Database integration test containers |

Linux system libraries for Tauri (Debian/Ubuntu; `just setup` installs these):

```bash
sudo apt install -y build-essential pkg-config libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev libssl-dev
```

Use `libayatana-appindicator3-dev`, not `libappindicator3-dev`: the latter
conflicts on Ubuntu 24.04.

## Setup

```bash
git clone https://github.com/EVWorth/sqlpilot.git
cd sqlpilot

mise install      # Node, Rust and just, at the pinned versions
just setup        # system deps, npm ci, git hooks (lefthook), Playwright Chromium
```

[`scripts/setup.sh`](scripts/setup.sh) is what `just setup` runs. It
installs mise if missing, and takes `--skip-system` and `--skip-mise`.

## Running

```bash
just dev          # desktop app (Tauri window)
just dev-web      # browser preview on http://localhost:1420
```

The browser preview has no backend. Open it with `?mock` to use the mock
backend in [`src/dev/mock/`](src/dev/mock/): `?mock=empty` for a first run,
`?mock=connected` to start connected. `just ui-snapshots` screenshots the main
screens on the mock backend into `ui-snapshots/` (set `CHROMIUM_PATH` if
Playwright's own Chromium is missing).

## Testing

```bash
just test               # Rust unit tests + frontend unit tests, no database
just test-frontend      # Vitest (jsdom)
just test-browser       # Vitest browser mode, real Chromium
just test-rust          # Rust tests that need no database

just db-up              # MySQL 8 on 13306, MariaDB 11 on 13308, shared by every worktree
just test-integration                       # #[ignore]d database tests, MySQL
MAS_TEST_PORT=13308 just test-integration   # the same against MariaDB
```

The containers are seeded from `tests/fixtures/sql/`, copied into their images
on the first `just db-up` rather than mounted, so they keep working when the
checkout that created them is gone. After changing a seed file, `just db-reset`
rebuilds them.

Run the integration tests before touching the connection manager, query
executor, schema inspector, backup/restore or admin service: CI runs them only
at release time. `just test-agents` drives a real Claude Code or Copilot CLI
and is never run in CI. Layout, ports and what runs where:
[docs/design/TESTING_STRATEGY.md](docs/design/TESTING_STRATEGY.md).

## Linting and formatting

```bash
just lint         # clippy, tsc --noEmit, dprint check, Tauri version check
npm run lint      # ESLint
just fmt          # cargo fmt + dprint fmt
just bindings     # regenerate src/lib/bindings.ts after changing a Tauri command
```

The lefthook pre-commit hook runs the unit tests, ESLint, the type check,
dprint, `cargo fmt --check`, clippy, and the lockfile and version checks on
staged files.

## Tasks

`just` with no arguments lists every task with its description; that listing
is the source of truth. The ones not covered above:

| Command               | Description                                          |
| --------------------- | ---------------------------------------------------- |
| `just build`          | Production desktop build (`npx tauri build`)         |
| `just test-all`       | `db-up`, unit tests and integration tests            |
| `just lint-workflows` | actionlint, pinned action SHAs, release script tests |
| `just db-down`        | Remove the test containers                           |
| `just db-seed`        | Re-apply `tests/fixtures/sql/seed.sql` to both       |
| `just db-reset`       | Rebuild the seeded images, recreate the containers   |
| `just ssl-certs`      | Generate certificates for the (unused) SSL container |
| `just bump <level>`   | Bump the version in every manifest and lockfile      |
| `just clean`          | Remove build output and test artifacts               |

## Environment variables

| Variable         | Used by                     | Effect                                                         |
| ---------------- | --------------------------- | -------------------------------------------------------------- |
| `RUST_LOG`       | the app                     | Console log filter. The JSON log file always logs at DEBUG     |
| `MAS_TEST_PORT`  | Rust integration tests      | Database port to test against; default 13306 (MySQL)           |
| `CHROMIUM_PATH`  | browser tests, ui-snapshots | Chromium binary to use instead of Playwright's own             |
| `TAURI_DEV_HOST` | `vite.config.ts`            | Host for the dev server when developing against another device |

## Project structure

```
sqlpilot/
├── src/                     React frontend
│   ├── components/          UI by area: admin, agent, backup, common, connection,
│   │                        designer, editor, explain, favorites, grid, history,
│   │                        import, layout, routine, schema, settings
│   ├── stores/              Zustand stores, one per domain
│   ├── lib/                 tauri-api.ts (IPC wrapper), generated bindings.ts,
│   │                        SQL generators, parsers, helpers
│   ├── hooks/  types/  styles/
│   └── dev/mock/            mock backend for the browser preview
├── src-tauri/               Rust backend (Cargo workspace)
│   ├── src/                 app crate: commands/, mcp/, menu, lib.rs
│   ├── crates/
│   │   ├── mas-core/        connections, queries, schema, backup/restore, history
│   │   ├── mas-admin/       process list, kill, server variables
│   │   ├── mas-export/      CSV, JSON, SQL INSERT, Markdown formatting
│   │   ├── mas-sqlite/      open and query user SQLite files
│   │   ├── mas-mcp/         MCP server for agents: tools, policy, endpoint
│   │   └── mas-agent/       agent harness integration
│   └── tests/               bindings export, agent end-to-end
├── tests/fixtures/          SQL seed data, SSL test config
├── docs/                    design and reference docs (see docs/README.md)
├── scripts/                 setup, release and CI helper scripts
├── docker-compose.test.yml  MySQL 8 (13306), MariaDB 11 (13308)
└── justfile                 tasks
```

How the pieces connect: [docs/design/ARCHITECTURE.md](docs/design/ARCHITECTURE.md).

## Making a change

1. Fork the repository and branch from `main` (`<type>/<scope>`, for example
   `fix/grid-copy`).
2. Make focused commits using conventional commit prefixes (`feat:`, `fix:`,
   `docs:`, `refactor:`, `test:`, `chore:`, `perf:`, `build:`, `ci:`).
3. Run the relevant gates: the tests for what you touched, `just lint`,
   `npm run lint`, and `npx dprint check`.
4. Open a pull request saying what changed and why. Keep it to one feature or
   fix.

Guidelines:

- TypeScript types mirror the Rust serde field names; most are snake_case.
- Components call store actions, never `api.*` directly.
- A new Tauri command needs registering in `src-tauri/src/lib.rs`, regenerated
  bindings (`just bindings`), and a handler in `src/dev/mock/handlers/`.
- App code imports relatively; the `@/` alias exists only for tests.
- Write tests for new features and bug fixes; put them in `__tests__/` next to
  the source.
- Update the docs for user-facing changes.
- Don't commit personal information: the repository is public.

Releases are cut by the maintainer; the process is in
[docs/RELEASING.md](docs/RELEASING.md).
