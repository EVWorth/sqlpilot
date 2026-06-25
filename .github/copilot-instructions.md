# Copilot Instructions — SQLPilot

## Caveman Mode (Token Optimization)

**why use many token when few do trick**

Caveman cuts ~75% output tokens while keeping full technical accuracy. Applies to all agents spawned for this project.

### Default: Full Intensity

Always use caveman speaking style:

- Drop articles (a/an/the), filler (just/really/basically), pleasantries (sure/certainly)
- Use fragments: `[thing] [action] [reason]. [next step].`
- Keep all technical accuracy — only remove fluff
- Code/commits/PRs write normal
- Short synonyms: `big` not `extensive`, `fix` not `implement solution for`
- ~75% token reduction, same technical substance

Examples:

- ❌ "Sure! I'd be happy to help. The issue is likely caused by..."
- ✅ "Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:"
- ❌ "Your component re-renders because you create a new object reference..."
- ✅ "New object ref each render. Inline object prop = new ref = re-render. Wrap in `useMemo`."

### Intensity Levels

| Level            | Trigger                   | What it do                                              |
| ---------------- | ------------------------- | ------------------------------------------------------- |
| **Lite**         | `/caveman lite`           | Drop filler, keep grammar. Professional but no fluff    |
| **Full**         | `/caveman full` (default) | Drop articles, fragments, full grunt                    |
| **Ultra**        | `/caveman ultra`          | Maximum compression. Telegraphic. Abbreviate everything |
| **Wenyan-Lite**  | `/caveman wenyan-lite`    | Semi-classical Chinese. Grammar intact, filler gone     |
| **Wenyan-Full**  | `/caveman wenyan`         | Full 文言文. Maximum classical terseness                |
| **Wenyan-Ultra** | `/caveman wenyan-ultra`   | Extreme. Ancient scholar on budget                      |

### Caveman Skills

- `/caveman-commit` — Terse commit messages. ≤50 char subject. Why over what. Conventional Commits.
- `/caveman-review` — One-line PR comments. `L42: 🔴 bug: user null. Add guard.` No throat-clearing.
- `/caveman-help` — Quick-reference card. All modes, skills, commands.
- `/caveman-compress <filepath>` — Compress memory files (CLAUDE.md, todos, etc.) into caveman-speak. ~46% input token save.

### Control

- Activate: `/caveman` or "talk like caveman" or "caveman mode"
- Stop: "stop caveman" or "normal mode"
- Level persists until changed or session end
- ACTIVE EVERY RESPONSE. No revert after many turns.

## Build, Test, and Lint

All common commands are in the `Makefile`. Rust tests require a running MySQL 8 Docker container.

```bash
# Start MySQL 8 test container (port 13306)
make db-up

# Run all tests (Rust integration + frontend unit)
make test

# Run only frontend unit tests
make test-frontend            # or: npx vitest run

# Run a single frontend test file
npx vitest run src/stores/__tests__/editorStore.test.ts

# Run only Rust tests (requires Docker MySQL on 13306)
make test-rust                # or: cd src-tauri && cargo test -p mas-core -p mas-export -p mas-admin

# Run a single Rust test by name
cd src-tauri && cargo test -p mas-core test_connect_mysql8

# E2E tests (Playwright)
make test-e2e                 # or: npx playwright test

# Lint (Rust clippy + TypeScript type check)
make lint

# Format
make fmt                      # Rust
npm run format                # TypeScript/CSS (Prettier)

# Full desktop dev (requires Tauri system deps)
make dev

# Browser-only frontend dev (no system deps needed)
make dev-web
```

## Architecture

This is a **Tauri 2** desktop app: a Rust backend exposing IPC commands consumed by a React/TypeScript frontend.

### Frontend → Backend IPC flow

1. **React components** call methods on `src/lib/tauri-api.ts` (the `api` object)
2. `tauri-api.ts` calls `invoke()` from `@tauri-apps/api/core`, which sends an IPC message to Rust
3. **Tauri commands** in `src-tauri/src/commands/mod.rs` handle the IPC call, delegating to service crates
4. Commands receive `AppState` via Tauri's managed state (`State<'_, AppState>`)

When adding a new feature, you typically touch: a Rust command, a `tauri-api.ts` method, a Zustand store action, and a React component.

### Rust workspace (`src-tauri/`)

The backend is a Cargo workspace with three library crates and the Tauri app crate:

| Crate             | Purpose                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mas-core`        | Connection pool management (`ConnectionManager`), query execution (`QueryExecutor`), schema inspection (`SchemaInspector`), and local SQLite storage for profiles (`ConnectionStore`) |
| `mas-export`      | Stateless export functions: CSV, JSON, SQL INSERT, Markdown                                                                                                                           |
| `mas-admin`       | Server admin: process list, server variables, kill process                                                                                                                            |
| `sqlpilot` (root) | Tauri app shell — registers commands, initializes state, sets up logging                                                                                                              |

New Tauri commands must be added to the `invoke_handler` array in `src-tauri/src/lib.rs`.

### Frontend (`src/`)

| Layer      | Location               | Notes                                                                                          |
| ---------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| State      | `src/stores/`          | Zustand stores (one per domain: connections, editor, results)                                  |
| IPC        | `src/lib/tauri-api.ts` | Single `api` object wrapping all Tauri `invoke()` calls                                        |
| Types      | `src/types/index.ts`   | Shared TypeScript types mirroring Rust models                                                  |
| Components | `src/components/`      | Organized by feature: `connection/`, `editor/`, `grid/`, `layout/`, `schema/`, `admin/`, `ai/` |

## Key Conventions

### Tauri command pattern (Rust)

Every Tauri command follows the same structure: `#[tauri::command]` + `#[tracing::instrument]`, receives `State<'_, AppState>`, returns `Result<T, String>`, and maps errors with `.map_err(|e| e.to_string())`. Follow this pattern when adding commands.

### Frontend state management

Zustand stores own all async logic. Components call store actions (e.g., `useConnectionStore().connect(profileId)`) — they never call `api.*` directly. Store actions handle loading/error state internally.

### Type mirroring

TypeScript types in `src/types/index.ts` mirror Rust `serde`-serialized structs. When changing a Rust model, update the corresponding TypeScript type. Field names use `snake_case` on both sides (Tauri's default serde behavior).

### Testing

- **Frontend tests** use Vitest + jsdom + React Testing Library. Test files live alongside source in `__tests__/` directories.
- **Rust integration tests** run against a real MySQL 8 container (port 13306). They live in `src-tauri/crates/mas-core/tests/`. The `test_profile()` helper creates a profile pointing at `127.0.0.1:13306`.
- **E2E tests** use Playwright.

### Docker test database

MySQL 8 runs on port **13306** (not 3306) to avoid conflicts. Credentials: `test_user`/`test_password` (root: `test_root_password`), database: `test_db`. Seed data loaded from `tests/fixtures/sql/`.

### Path alias

The frontend uses `@/` as a path alias for `src/` (configured in `vitest.config.ts` and `vite.config.ts`).

### Styling

Tailwind CSS with `clsx` + `tailwind-merge` for conditional class merging. Prettier plugin auto-sorts Tailwind classes.
