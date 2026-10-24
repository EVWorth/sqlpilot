# SQLPilot — Testing Strategy

How the tests are laid out, what each layer covers, and where each one runs.
For the commands, see the [`justfile`](../../justfile) (`just --list`).

## Layers at a glance

| Layer                     | Tool                             | Needs                     | On PRs | At release     |
| ------------------------- | -------------------------------- | ------------------------- | ------ | -------------- |
| Frontend unit             | Vitest + jsdom + RTL             | nothing                   | yes    | no             |
| Frontend browser          | Vitest browser mode + Playwright | Chromium                  | yes    | no             |
| Rust unit                 | `cargo test`                     | nothing                   | yes    | yes (coverage) |
| Rust integration, no DB   | `cargo test` (`tests/` dirs)     | nothing                   | yes    | yes (coverage) |
| Rust database integration | `cargo test -- --ignored`        | MySQL 8 and MariaDB 11    | no     | yes            |
| Live agent tests          | `cargo test -- --ignored`        | databases + logged-in CLI | no     | no             |
| Contract checks           | Vitest, `cargo test`, shell      | nothing                   | yes    | no             |

There is no end-to-end suite. One existed, never ran, and was removed: it drove
the Vite dev server, but the app needs a Tauri window.

## Frontend

### Unit tests (jsdom)

- Config: [`vitest.config.ts`](../../vitest.config.ts). Picks up
  `src/**/*.{test,spec}.{ts,tsx}` and excludes `*.browser.*` files.
- Setup: [`src/test-setup.ts`](../../src/test-setup.ts) loads jest-dom and the
  app stylesheet, mocks the updater and process plugins, and polyfills
  `localStorage`.
- Tests are co-located in `__tests__/` next to the source:
  `src/components/*/__tests__/`, `src/stores/__tests__/`,
  `src/lib/__tests__/`, `src/hooks/__tests__/`, `src/types/__tests__/`.
- The `@/` alias resolves to `src/` here (and in `tsconfig.json`) but not in
  `vite.config.ts`. Tests may use it; app code must not.
- Coverage excludes `src/dev/**` (the mock backend is dev tooling).

Run: `just test-frontend`, `npm run test:unit`, or `npx vitest run <file>`.

### Browser tests (real Chromium)

- Config: [`vitest.browser.config.ts`](../../vitest.browser.config.ts). Picks
  up `src/**/*.browser.{test,spec}.{ts,tsx}` only.
- Used where jsdom cannot answer the question: layout and geometry, focus,
  Monaco, resizable panels. Examples:
  [`AppLayout.browser.test.tsx`](../../src/components/layout/__tests__/AppLayout.browser.test.tsx),
  [`SQLEditor.browser.test.tsx`](../../src/components/editor/__tests__/SQLEditor.browser.test.tsx),
  [`ResultsGrid.browser.test.tsx`](../../src/components/grid/__tests__/ResultsGrid.browser.test.tsx),
  [`main.browser.test.tsx`](../../src/__tests__/main.browser.test.tsx).
- The viewport is fixed at 1280x800, a desktop window. Monaco is pre-bundled
  through `optimizeDeps` so a cold cache does not reload the page mid-run.
- `CHROMIUM_PATH` overrides the browser binary when Playwright's own build is
  missing (CI images, cloud containers).

Run: `npm run test:browser` or `just test-browser`.

Chromium is not the app's webview (WebKitGTK on Linux, WebView2 on Windows,
WKWebView on macOS). These tests check layout and behaviour, not
webview-specific rendering.

### Mock backend

[`src/dev/mock/`](../../src/dev/mock/) answers every Tauri command with fixed
fixture data, so the UI runs in a plain browser (`just dev-web`, then
`http://localhost:1420/?mock`). Handlers live in
[`src/dev/mock/handlers/`](../../src/dev/mock/handlers/).

[`src/dev/mock/__tests__/coverage.test.ts`](../../src/dev/mock/__tests__/coverage.test.ts)
fails when a command in the generated bindings has no handler, or when a
handler exists for a command that no longer does. Adding a Tauri command
therefore means adding a mock handler.

`just ui-snapshots` ([`scripts/ui-snapshots.mjs`](../../scripts/ui-snapshots.mjs))
screenshots the main screens on the mock backend into `ui-snapshots/`. It is a
review aid, not a test.

## Rust

### Unit tests

`#[cfg(test)]` modules inside `src-tauri/src/` and `src-tauri/crates/*/src/`.
No database, no network.

### Integration tests

Each crate's `tests/` directory:

| Location                                                                         | Covers                                              |
| -------------------------------------------------------------------------------- | --------------------------------------------------- |
| [`src-tauri/crates/mas-core/tests/`](../../src-tauri/crates/mas-core/tests/)     | connections, queries, schema, backup/restore, edits |
| [`src-tauri/crates/mas-admin/tests/`](../../src-tauri/crates/mas-admin/tests/)   | process list, kill, server variables, user DDL      |
| [`src-tauri/crates/mas-mcp/tests/`](../../src-tauri/crates/mas-mcp/tests/)       | MCP tools, the endpoint, generated SQL              |
| [`src-tauri/crates/mas-sqlite/tests/`](../../src-tauri/crates/mas-sqlite/tests/) | the local store, on in-memory SQLite                |
| [`src-tauri/crates/mas-agent/tests/`](../../src-tauri/crates/mas-agent/tests/)   | the ACP client; live harness tests                  |
| [`src-tauri/tests/`](../../src-tauri/tests/)                                     | bindings export, agent end-to-end                   |

Tests that need a live database are marked `#[ignore]`, so the default
`cargo test` stays container-free. Files with no ignored tests (for example
`mas-mcp/tests/tools.rs`, `mas-mcp/tests/endpoint.rs`,
`mas-core/tests/connect_diagnosis.rs`, `mas-agent/tests/acp.rs`,
`mas-sqlite/tests/integration_tests.rs`) run on every PR.

Run the PR set locally with `just test-rust`. It runs the library crates with
all targets, then `cargo test -p sqlpilot --lib`, because the app crate's own
`tests/` need a harness or a database.

### Database integration tests

These run against two servers from
[`docker-compose.test.yml`](../../docker-compose.test.yml):

| Service      | Container        | Host port | Started by `just db-up` |
| ------------ | ---------------- | --------- | ----------------------- |
| `mysql-8`    | `mas-mysql-8`    | 13306     | yes                     |
| `mariadb-11` | `mas-mariadb-11` | 13308     | yes                     |
| `mysql-5_7`  | `mas-mysql-57`   | 13307     | no (defined, unused)    |
| `mysql-ssl`  | `mas-mysql-ssl`  | 13309     | no (defined, untested)  |

Credentials: root / `test_root_password`, plus `test_user` / `test_password`
on `test_db`. Nothing uses port 3306.

Seed data is in [`tests/fixtures/sql/`](../../tests/fixtures/sql/).
[`seed.sql`](../../tests/fixtures/sql/seed.sql) builds `test_db` (tables
covering the MySQL type range, relations, Unicode, views, routines, triggers,
events) and an empty `test_db_empty`.
[`seed_large.sql`](../../tests/fixtures/sql/seed_large.sql) adds `large_table`
for paging and memory tests; only the MySQL container loads it. Some suites
(`backup_dump`, `restore_file`, `ddl_pool_safety`, `paging_offset`) create and
drop their own databases.

Every database test reads `MAS_TEST_PORT`, defaulting to 13306. Run both
servers:

```bash
just db-up
just test-integration                       # MySQL 8
MAS_TEST_PORT=13308 just test-integration   # MariaDB 11
```

`test-integration` runs `mas-core`, `mas-admin` and `mas-mcp` with
`--ignored --test-threads=1`. One thread is required: the suites share fixture
databases and collide when run in parallel.

Other recipes: `just db-seed` re-applies `seed.sql`, `just db-reset`
recreates the containers, `just db-down` removes them, and `just ssl-certs`
generates certificates for the unused SSL service.

Run these before touching the connection manager, query executor, schema
inspector, backup/restore or admin service. CI does not run them on PRs.

### Live agent tests

`mas-agent/tests/live_copilot.rs`, `mas-agent/tests/live_claude.rs` and
[`src-tauri/tests/agent_end_to_end.rs`](../../src-tauri/tests/agent_end_to_end.rs)
drive a real agent CLI against the MCP endpoint and a live database. They need
`just db-up` and the CLI installed and logged in, and they spend the user's
quota.

Run: `just test-agents`. No CI job runs them.

## Contract checks

These catch drift between layers rather than behaviour.

| Check                                                                                                        | Catches                                                  | CI job             |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------ |
| [`src-tauri/tests/export_bindings.rs`](../../src-tauri/tests/export_bindings.rs)                             | `src/lib/bindings.ts` out of date with the Rust commands | `lint-rust`        |
| [`src/lib/__tests__/tauri-command-contract.test.ts`](../../src/lib/__tests__/tauri-command-contract.test.ts) | Rust commands that nothing in `tauri-api.ts` calls       | `test-frontend`    |
| [`src/dev/mock/__tests__/coverage.test.ts`](../../src/dev/mock/__tests__/coverage.test.ts)                   | commands with no mock handler, stale handlers            | `test-frontend`    |
| [`scripts/check-test-mocks.sh`](../../scripts/check-test-mocks.sh)                                           | relative `vi.mock` paths that resolve to nothing         | `check-test-mocks` |
| [`scripts/check-documented-commands.sh`](../../scripts/check-documented-commands.sh)                         | ARCHITECTURE section 5 naming commands that do not exist | `check-docs`       |

Removing a command from Rust breaks `tsc`, because `tauri-api.ts` calls the
generated `commands.*`. Run `just bindings` after changing a command.

## Where tests run

### Pre-commit ([`lefthook.yml`](../../lefthook.yml))

When staged files include `ts`, `tsx` or `rs`: `npm run test:unit`. The hook
also runs lint, type check, dprint, `cargo fmt --check`, clippy, and the
lockfile and version checks. Browser tests and Rust tests are not in the hook.

### Pull requests ([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml))

`detect-changes` path-filters the PR; each job runs only when its paths
change.

| Job                | Runs                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `test-frontend`    | `npm run test:unit -- --coverage`, then `npm run test:browser`                                             |
| `test-rust`        | library crates' tests; `cargo test -p sqlpilot --lib`; `cargo test -p mas-mcp -p sqlpilot --test endpoint` |
| `lint-rust`        | fmt, clippy, bindings freshness                                                                            |
| `check-test-mocks` | `scripts/check-test-mocks.sh`                                                                              |
| `check-docs`       | `scripts/check-documented-commands.sh`                                                                     |
| `lint-workflows`   | actionlint, action pins, and the tests for the release scripts                                             |

The extra `endpoint` step builds `mas-mcp`'s endpoint tests together with the
app crate. Only that build unifies `reqwest` features with the updater plugin,
which is where the TLS provider panic showed up (#717, #773).

### Release ([`.github/workflows/release.yml`](../../.github/workflows/release.yml))

The `integration-db` job runs before any platform build, with MySQL 8 and
MariaDB 11 as service containers on 13306 and 13308. It seeds both, runs the
ignored tests against each (`MAS_TEST_PORT=13308` for MariaDB), then runs
`cargo tarpaulin` over `mas-core`, `mas-export`, `mas-admin` and `mas-mcp`
with `--include-ignored` and uploads the coverage. A failure blocks the
release. Live agent tests are not run.

## Writing tests

- Frontend: put the test in the nearest `__tests__/`. Mock `api.*`
  (`src/lib/tauri-api`) or the store rather than reaching into Tauri. Relative
  `vi.mock` paths must resolve; the CI check enforces it.
- Use a browser test only when the assertion depends on real layout or a real
  browser API.
- Rust: a test that needs a server gets `#[ignore]`, reads `MAS_TEST_PORT`
  with 13306 as the default, and must pass on both MySQL 8 and MariaDB 11.
- A test that creates databases should use its own name (or a random suffix,
  as `agent_end_to_end.rs` does) and clean up after itself.
