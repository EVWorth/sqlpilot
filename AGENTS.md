# SQLPilot — Agent Guide

Shared instructions for any coding agent working in this repository (Claude
Code, GitHub Copilot, others). Claude Code loads this through `CLAUDE.md`;
Claude-specific setup (subagents, skills, file ownership) lives there.

## The project

SQLPilot is a Tauri 2 desktop MySQL/MariaDB GUI for Linux, Windows and macOS.

- **Backend:** a Cargo workspace in `src-tauri/`. The root `sqlpilot` crate is
  the Tauri app shell; the libraries are `mas-core` (connections, queries,
  schema, backup/restore, history), `mas-admin`, `mas-export`, `mas-sqlite`,
  `mas-mcp` (the MCP server agents use) and `mas-agent` (running the user's
  agent harness). Conventions: [`src-tauri/CLAUDE.md`](src-tauri/CLAUDE.md).
- **Frontend:** React 19 and TypeScript in `src/`, built with Vite, Tailwind 4,
  Zustand 5 and Monaco. Conventions: [`src/CLAUDE.md`](src/CLAUDE.md).
- **Docs:** [`docs/README.md`](docs/README.md) indexes the design and process
  docs. Read a design doc when your change touches its area, not up front.

## Commands

Every task is a `just` recipe; `just` lists them.

| Task                          | Command                                                   |
| ----------------------------- | --------------------------------------------------------- |
| Desktop app                   | `just dev`                                                |
| UI in a browser, mock data    | `just dev-web`, open `http://localhost:1420/?mock`        |
| Frontend unit tests           | `npx vitest run <file>` (all: `npm run test:unit`)        |
| Browser tests (real Chromium) | `npm run test:browser`                                    |
| Rust tests (no database)      | `cd src-tauri && cargo test -p <crate>`                   |
| Integration tests (database)  | `just db-up`, then `just test-integration`                |
| Regenerate TS bindings        | `just bindings`                                           |
| Lint and format               | `just lint`, `npx dprint fmt`                             |
| Bump the version              | `just bump [patch\|minor\|major]` (asks for confirmation) |

## Gates — run before calling anything done

Local failure is CI failure. Run the subset your change touches; don't skip one
and don't report one as passing that you didn't run.

- **Frontend:** `npm run lint`, `npm run type-check`, `npx vitest run <file>`
  for the affected tests, and `npm run test:browser` when a
  `*.browser.test.tsx` file or the code it covers changed.
- **Rust:** `cargo fmt --all`, then
  `cargo clippy --workspace --all-targets --all-features -- -D warnings` and
  `cargo test -p <crate>`, all from `src-tauri/`.
- **Connection manager, executor, schema inspector, backup/restore or admin:**
  the integration tests against MySQL (port 13306) and again against MariaDB
  (`MAS_TEST_PORT=13308`). CI runs these only at release time.
- **Everything:** `npx dprint check --list-different`.
- **Versions:** `package.json`, `src-tauri/Cargo.toml` and
  `src-tauri/tauri.conf.json` must agree. Lefthook checks on commit; fix drift
  with `just bump`.

## Conventions that bite

1. **IPC chain:** component → store action → `api.*` (`src/lib/tauri-api.ts`)
   → generated `commands.*` (`src/lib/bindings.ts`) → `#[tauri::command]` in
   `src-tauri/src/commands/`. Components never call `api.*`. Store actions own
   loading and error state.
2. **A new Tauri command touches six places:** the command, the
   `collect_commands!` list in `specta_builder()` (`src-tauri/src/lib.rs`, the
   one list both the runtime handler and the bindings come from),
   `src/lib/bindings.ts` (via
   `just bindings`, never by hand), `src/lib/tauri-api.ts`, a mock handler in
   `src/dev/mock/handlers/`, and tests. `src/dev/mock/__tests__/coverage.test.ts`
   fails if the mock is missing.
3. **TS types are snake_case**, matching Rust serde. Don't camelCase them.
4. **`@/` is a test-only alias.** It resolves in `vitest.config.ts` and
   `tsconfig.json`, not in `vite.config.ts`. App code imports relatively; tests
   may use `@/`.
5. **Tests sit next to the code**, in `__tests__/` directories.
6. **Test databases use ports 13306 (MySQL) and 13308 (MariaDB)**, never 3306.
7. **CSP keeps `unsafe-eval` and inline styles** because Monaco needs them. Read
   `docs/SECURITY.md` before touching CSP or Tauri permissions.
8. **Lockfiles are generated.** A dependency change in `package.json` needs a
   regenerated `package-lock.json` (lefthook blocks it otherwise). Never
   hand-edit `*.lock` files.
9. **New dependencies wait a week.** Dependabot's cooldown holds bumps for 7
   days; security fixes are exempt.
10. **There is no E2E suite.** It could not drive a Tauri window and was
    removed. `src/lib/__tests__/tauri-command-contract.test.ts` covers the
    Rust↔JS command contract.

## Working rules

These come from the maintainer.

- **Everything lands through a pull request.** Never push to `main`, never
  force-push `main`.
- **Anything wrong gets an issue.** A failing check, a broken test setup, a
  regression, a stale comment, a CI gap: file a GitHub issue as soon as you
  find it, even outside the task at hand. Include the command that shows it,
  its output, the cause if known, and a fix. Don't widen the current PR to
  cover it.
- **No personal information in the repo, commits, PRs or issues.** The repo is
  public. No names, email addresses, usernames, home-directory paths,
  hostnames or account IDs; use placeholders such as `$HOME` or repo-relative
  paths.
- **Never commit secrets,** certificates or `.env` files.
- **Never disable a CI gate to get green.** Fix the cause.
- **Never edit generated output:** `node_modules/`, `dist/`, `coverage/`,
  `src-tauri/target/`, lockfiles, `src/lib/bindings.ts`.

## Commits and PRs

Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
`test:`, `perf:`, `build:`, `ci:`), subject of 50 characters or fewer, body
only when the why isn't obvious. Code, commits, PRs and issues are written in
plain English for people who weren't in the conversation.
