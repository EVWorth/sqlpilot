# SQLPilot — Agent Operations Manual

Read this first in every session. Subagents are in `.claude/agents/`, slash
commands in `.claude/commands/`, and permissions in `.claude/settings.json`.

## Project in One Paragraph

SQLPilot is a Tauri 2 desktop MySQL/MariaDB GUI for Linux, Windows and macOS.
The Rust backend is a Cargo workspace in `src-tauri/`: the root `sqlpilot`
app crate plus `mas-core` (connections, queries, schema, backup/restore),
`mas-admin`, `mas-export`, `mas-sqlite`, `mas-mcp` (the MCP server agents
use) and `mas-agent` (harness integration). The frontend is React 19 and
TypeScript, built with Vite 8, Tailwind 4, Zustand 5 and Monaco. Gates are
strict: tests, dprint, cargo fmt, clippy, cargo audit and version
consistency.

## Working agreements

These come from the maintainer. Follow them without asking again.

- **"Release" means ship it, end to end.** Don't stop to ask which version or
  whether to go ahead. Follow the Release Flow below. Use a minor version
  when features landed and a patch when only fixes did. Open the release PR,
  get CI green (fixing any new advisories in the same PR), merge it, tag
  `v<version>` on the merge commit, and see `release.yml` through to the
  published release. Publish the draft once every platform's build is
  attached.
- **Anything wrong gets an issue.** A failing check, a broken test setup, a
  regression, a stale comment, a gap in CI: file a GitHub issue for it as
  soon as you find it, even when it is outside the task at hand. Include the
  command that shows it, its output, the cause if you know it, and a fix.
  Don't widen the current PR to cover it.
- **No personal information in the repo.** It is public. Don't commit names,
  email addresses, usernames, home-directory paths, hostnames, account IDs or
  anything else that identifies a person or their machine. That covers code,
  docs, tests, fixtures and this file. Use placeholders such as `$HOME`, or
  paths relative to the repo. Commits, PRs and issues are public too, so the
  same applies there.
- **Write lasting instructions down here.** When the maintainer sets a rule
  for how to work, add it to this file in the same session.

## Read Once, Internalize

**Project conventions:**

- `.github/copilot-instructions.md` — IPC flow, crate boundaries, test setup,
  build commands. Its "Caveman Mode" is for Copilot; follow Output Style
  below instead.

**Design (skim, don't memorize):**

- `docs/design/TECH_DECISIONS.md` — ADRs for major tech picks. Read when
  picking new tech or wondering "why X not Y".
- `docs/design/DESIGN_REQUIREMENTS.md` — functional and non-functional
  requirements with status annotations. Source of truth for "what was
  promised".

**Reference (lookup, don't preload):**

- `docs/design/ARCHITECTURE.md` — IPC chain details, Tauri security model.
  Read on demand when touching cross-cutting concerns.
- `docs/design/AI_INTEGRATION.md` — the MCP surface, agent sessions, grants.
- `docs/design/TESTING_STRATEGY.md` — test layout, MySQL container rules.
  Read when writing integration tests.
- `docs/SECURITY.md` — CSP, threat model. Read before touching CSP or
  permissions.
- `docs/RELEASING.md` — the release pipeline and its pitfalls.
- `README.md` — user-facing feature list. Read before adding user-visible
  features.

**Seeing the UI without the desktop app:** `just dev-web`, then open
`http://localhost:1420/?mock` (`?mock=empty` for a first run, `?mock=connected`
to start connected). The mock backend in `src/dev/mock/` answers every command
with fixed fixture data. `just ui-snapshots` screenshots the main screens into
`ui-snapshots/`; set `CHROMIUM_PATH` if Playwright's own Chromium is missing.

If any reference doc grows past ~1.5x its current size or contradicts code,
flag it to doc-keeper.

## Team Roster

The main session is the team lead: it dispatches, verifies and owns design.
Specialists are subagents in `.claude/agents/`; delegate to them by name.

| Member                   | Scope                                               | Tools                    |
| ------------------------ | --------------------------------------------------- | ------------------------ |
| **team lead** (main)     | dispatch, verify, design decisions                  | all                      |
| **scout**                | codebase mapping, file location, dependency tracing | read-only + Bash         |
| **implementer-frontend** | React/TS, Zustand stores, types, tests              | edit, in `src/` only     |
| **implementer-rust**     | Rust/Tauri commands, crates, IPC handlers           | edit, in `src-tauri/`    |
| **reviewer**             | diff review, one-line findings w/ severity emojis   | read-only + Bash         |
| **doc-keeper**           | `docs/`, README, `CLAUDE.md`, drift detection       | edit, in its files only  |
| **release-cutter**       | version bumps, tags, release prep, manifest         | edit version files, Bash |
| **ci-doctor**            | debug failing CI runs, log triage                   | read-only + Bash         |
| **issue-reviewer**       | issue triage from the cached issue list             | read-only + Bash, web    |

A subagent's tool list says what it may use, not where. The edit scopes above
are rules each agent's prompt repeats, and the File Ownership table below is
the source of truth.

## File Ownership — Don't Cross

| Path                                                                  | Owner                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------- |
| `src/`                                                                | implementer-frontend                                    |
| `src-tauri/src/`, `src-tauri/crates/*/src/`                           | implementer-rust                                        |
| `src-tauri/tauri.conf.json`                                           | implementer-rust (version field: release-cutter)        |
| `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`                        | implementer-rust                                        |
| `docs/`                                                               | doc-keeper (escalate substantial rewrites to team lead) |
| `package.json`, `package-lock.json`                                   | implementer-frontend (deps) / release-cutter (version)  |
| `.github/workflows/`                                                  | team lead                                               |
| `.claude/`, `CLAUDE.md`                                               | team lead (doc-keeper may fix drift in `CLAUDE.md`)     |
| `lefthook.yml`, `eslint.config.js`, `dprint.json`, `vitest.config.ts` | team lead                                               |

Cross-domain edits require explicit approval. If unsure who owns it, ask the
team lead.

## Output Style

Terse chat output. Code, commits, PRs, issues and log lines: write normal
English.

- Drop filler (just/really/basically/actually) and pleasantries
  (sure/certainly/of course).
- Short synonyms: `big` not `extensive`, `fix` not `implement solution for`.
- Fragments OK: `[thing] [action] [reason]. [next step].`

Don't overdo it. Correctness > terseness.

## Pre-Commit Gates — Must Pass Before Done

Run the relevant subset. Don't skip, don't lie.

**Frontend changes:**

```bash
npm run lint              # eslint src
npm run type-check        # tsc --noEmit
npx vitest run <file>     # affected test, not whole suite unless touching shared code
```

**Rust changes:**

```bash
cd src-tauri && cargo fmt --all
cd src-tauri && cargo clippy --workspace --all-targets --all-features -- -D warnings
cd src-tauri && cargo test -p <crate> --verbose
```

**Connection manager, executor, schema inspector, backup/restore or admin:**
`just db-up`, then `just test-integration` against MySQL (port 13306), and
again with `MAS_TEST_PORT=13308` for MariaDB. CI runs these only at release
time.

**Both:**

```bash
npx dprint check --list-different
```

**Version check** (lefthook auto-runs):

- `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` must
  share a version.
- Drift? `just bump [patch|minor|major]` updates all three atomically.

Local failure = CI failure. Don't ship red.

## Common Pitfalls — Read Before Touching Code

1. **TS types use snake_case.** Matches Rust serde. Don't camelCase. Tauri
   default behavior.
2. **Tauri command pattern:** `#[tauri::command]` + `#[tracing::instrument]` +
   `State<'_, AppState>` → `Result<T, String>` + `.map_err(|e| e.to_string())`.
   New commands must be added to the `invoke_handler` array in
   `src-tauri/src/lib.rs`, to `src/lib/bindings.ts` via `just bindings`, and
   to the mock backend in `src/dev/mock/handlers/` (a test fails otherwise).
3. **IPC chain:** Component → store action → `api.*`
   (`src/lib/tauri-api.ts`) → `invoke()` → `src-tauri/src/commands/mod.rs`.
   Components NEVER call `api.*` directly.
4. **Store actions own loading/error state.** Components don't track it.
5. **Tests co-located** in `__tests__/` next to source. Vitest + jsdom + RTL.
6. **Path alias:** `@/` → `src/` exists only in `vitest.config.ts` and
   `tsconfig.json`, not in `vite.config.ts`. Tests may use it; app code must
   import relatively, or the dev server and the build fail to resolve it.
7. **CSP:** Monaco forces `unsafe-eval` + `unsafe-inline` styles. Don't try to
   "fix" it — see `docs/SECURITY.md`.
8. **Test databases** on ports **13306** (MySQL) and **13308** (MariaDB), not
   3306. `just db-up` brings them up. CI uses service containers on the same
   ports.
9. **Lockfile discipline:** a `package.json` change needs a
   `package-lock.json` change. Lefthook blocks the commit otherwise. Never
   hand-edit a lockfile; regenerate it with npm or cargo.
10. **Dep age gate:** Dependabot waits 7 days before offering a bump, and
    `npm run deps:check` fails on npm packages younger than that. Security
    fixes are exempt.
11. **No E2E suite:** removed — it never ran and could not work (it drove the
    vite dev server, but the app needs a Tauri window). The Rust↔JS command
    contract is covered by `src/lib/__tests__/tauri-command-contract.test.ts`.
12. **Windows signing secrets** in `release.yml` are optional — the workflow
    skips signing if they are absent. Don't assume they exist.
13. **`bundle.createUpdaterArtifacts: true`** in `tauri.conf.json` makes the
    bundler sign artifacts during `tauri build`, so the build step (not just
    the manifest step) needs `TAURI_SIGNING_PRIVATE_KEY`. Miss it and every
    build fails with `A public key has been found, but no private key.` See
    `docs/RELEASING.md` (issue #243).

## Dispatch Patterns — Quick Routing

| User intent                                              | Dispatch to                         |
| -------------------------------------------------------- | ----------------------------------- |
| "Where does X live?" / "Find code that does Y"           | scout                               |
| "Implement Y in React/TS" / "Add component/store/type"   | implementer-frontend                |
| "Implement Y in Rust" / "Add Tauri command" / "Wire IPC" | implementer-rust                    |
| "Review this diff" / "What did I break?"                 | reviewer                            |
| "Are the docs current?" / "Update README for X"          | doc-keeper, or `/doc-keeper`        |
| "Find bugs / file issues"                                | `/findissues`                       |
| "Triage open issues"                                     | `/reviewissues`                     |
| "Review agent PRs"                                       | `/review-prs`                       |
| "Bump version" / "Cut release"                           | Release Flow below; `/bump` to bump |
| "Debug failing CI"                                       | ci-doctor                           |
| "Architecture / design question"                         | team lead — never delegate design   |
| Anything else                                            | team lead decides                   |

When a subagent does the work, say so. Don't present a general-purpose
agent's output as a specialist's.

## Commits

Use conventional commits. Subject of 50 characters or fewer. Body only when
the why isn't obvious from the subject. Prefixes: `feat:`, `fix:`, `chore:`,
`docs:`, `refactor:`, `test:`, `perf:`, `build:`, `ci:`.

## Agent Work → PRs (Not Direct Commits)

**All agent-produced changes flow through PRs.** Nothing lands on `main`
without one. Branch (`<type>/<scope>`, or the session's assigned branch),
commit, push, open a PR.

**Review protocol:** use the reviewer subagent, or `/review-prs`. Read the
diff and any report file. Post terse findings with severity emojis. The
maintainer makes the final call, except where a working agreement above
says otherwise.

## On-Demand Doc-Keeper

Doc maintenance, **run when needed** (not scheduled):
`bash scripts/doc-keeper-sweep.sh`, or `/doc-keeper`. The script enforces
pre-flight checks (clean tree, on main, `gh` authenticated, no open
doc-keeper PR). If it finds drift it opens a branch and PR; otherwise it
exits silently. It runs `claude -p --agent doc-keeper`, so the Claude Code
CLI must be installed and signed in.

## Release Flow

0. **Pre-flight** (from a clean main checkout):
   `bash scripts/check-release-readiness.sh --strict` — verifies the
   manifests agree, the tree is clean and you are on main.
1. `just bump [patch|minor|major]` — sets the version in the three manifests
   and in both lockfiles' entries for the app itself.
2. Commit the bump in a release PR (no tag yet) and get CI green.
3. After merging, re-check on the merge commit:
   `bash scripts/check-release-readiness.sh <new-version>`.
4. `git tag -a v<version>` on the merge commit and push the tag. That
   triggers `.github/workflows/release.yml`, whose `validate` job fails fast
   if the tag doesn't match the manifests.
5. The workflow builds 4 platforms, signs Windows (if cert secrets are
   present), and generates the `latest.json` update manifest.
6. It creates a **draft** release. Publish it once every platform's build is
   attached (see Working agreements).

Before touching `release.yml` or `TAURI_*` env vars, read the gotchas in
`docs/RELEASING.md`: race conditions, signing-key env var, rpm manifest gap,
Linux deps, re-tag protocol.

## Cloud sessions

- The session's git access pushes only to its own branch. **Tag pushes get
  HTTP 403**, and the GitHub tools cannot create tags or publish releases.
  For a release, merge the PR. Then give the maintainer the exact
  `git tag -a` and `git push origin v<version>` commands, and say that the
  draft release needs publishing.
- Once a PR merges, GitHub deletes the session branch. Recreate it from
  `origin/main`.
- The disk fills quickly with test binaries. Before a long test run, delete
  `src-tauri/target/debug/incremental` and the large executables in
  `src-tauri/target/debug/deps`, and run with `CARGO_INCREMENTAL=0`.
- Docker doesn't survive a container restart. Start `dockerd`, then
  `just db-up`.
- `src/__tests__/main.test.tsx` times out in the container but passes in CI.
- Parallel subagents each get their own `git worktree`. Tell them never to
  use `git stash`: the stash list is shared by every worktree, so one agent's
  `stash pop` takes another agent's changes. To test that a fix is needed,
  save a patch with `git diff > file` and reverse-apply it instead.

## When You're Stuck

- Read the relevant design doc in `docs/design/` first.
- Search the codebase (or ask scout) before guessing.
- Check git log for recent similar work: `git log --oneline -20 -- <path>`.
- If still stuck after 3 searches, ask the maintainer — don't spiral.

## Sacred Rules

1. Never commit secrets, certs, `.env` files or personal information.
2. Never force-push to `main`.
3. Never edit `node_modules/`, `dist/`, `coverage/` or `src-tauri/target/`,
   and never hand-edit `*.lock` / `*.lockb` (regenerate them with their
   tools).
4. Never disable a CI gate to make it pass — fix the underlying issue.
5. Never edit outside your ownership lane without approval.
6. **Never push agent work directly to `main`. PRs only.**
7. When in doubt: read the design docs, then ask.
