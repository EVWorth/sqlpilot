# Backend conventions (`src-tauri/`)

Applies to everything under `src-tauri/`. Project-wide rules are in
`AGENTS.md`. Run Cargo from this directory.

## Crates

| Crate             | Owns                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `sqlpilot` (root) | Tauri shell: commands (`src/commands/`), `AppState`, menus, the in-app MCP bridge (`src/mcp/`) |
| `mas-core`        | connection pools, profile store, query execution, schema, backup/restore, query history        |
| `mas-admin`       | server administration: process list, variables, kill query/process                             |
| `mas-export`      | stateless exporters (CSV, JSON, SQL, Markdown)                                                 |
| `mas-sqlite`      | opening and querying the user's own SQLite database files                                      |
| `mas-mcp`         | the MCP server agents talk to: tools, grants, policy, the `Workspace` seam to the app          |
| `mas-agent`       | launching and talking to the user's agent harness (Claude Code, Copilot)                       |

Put code in the crate that owns the concern; the root crate stays a thin shell.
Shared dependency versions live in `[workspace.dependencies]` in `Cargo.toml`.

## Tauri commands

Commands live in `src/commands/` (`mod.rs` plus `agents.rs`, `backup.rs`,
`sqlite.rs`); `AppState` is defined in `src/commands/mod.rs`. Every command
follows this shape:

```rust
#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn thing(state: State<'_, AppState>, id: String) -> Result<Thing, String> {
    mas_core::thing::load(&state.pool, &id).await.map_err(|e| e.to_string())
}
```

Register it in `collect_commands!` inside `specta_builder()` in `src/lib.rs`.
That one list feeds the runtime handler and the generated TypeScript, so then
run `just bindings`. The `add-tauri-command` skill has the full checklist,
including the frontend half.

## Rules

- Async throughout; wrap blocking work in `tokio::task::spawn_blocking`.
- Each crate has its own error enum (see `mas-core/src/error.rs`). Map to
  `String` only at the command boundary.
- No `unwrap()`, `expect()` or `panic!` on production paths; return `Result`.
- No `unsafe` without a comment saying why it is sound.
- `#[tracing::instrument]` on commands and public service functions; skip
  large or secret arguments (`skip(state)`, passwords).
- Match TypeScript with snake_case field names rather than `serde(rename)`.

## Tests

- Unit tests in `#[cfg(test)] mod tests` next to the code:
  `cargo test -p <crate>`. They need no database.
- Database tests are `#[ignore]`d integration tests in
  `crates/<crate>/tests/`; each defines a `test_profile()` pointing at
  `127.0.0.1:13306` (or `MAS_TEST_PORT`). Run them with the
  `integration-tests` skill.
- `tests/export_bindings.rs` regenerates the frontend's `src/lib/bindings.ts` (at the repo root);
  `tests/agent_end_to_end.rs` and the live harness tests run through
  `just test-agents` and need a logged-in harness.
