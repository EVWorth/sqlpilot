---
name: add-tauri-command
description: Checklist for adding, renaming or changing the signature of a Tauri command in SQLPilot, across the Rust command, the specta command list, generated bindings, tauri-api.ts, the store, the mock backend and tests. Use whenever a change crosses the IPC boundary.
---

# Add or change a Tauri command

The chain is component → store action → `api.*` → `commands.*` (generated) →
Rust. Do the steps in order; each one makes the next compile.

## Rust (`src-tauri/`)

1. **Service code** in the crate that owns the concern (`mas-core`,
   `mas-admin`, ...), returning that crate's error type. Unit-test it there.
2. **The command** in `src-tauri/src/commands/` (`mod.rs`, or `agents.rs`,
   `backup.rs`, `sqlite.rs` for those areas):

   ```rust
   #[tauri::command]
   #[tracing::instrument(skip(state))]
   #[specta::specta]
   pub async fn thing(state: State<'_, AppState>, id: String) -> Result<Thing, String> {
       service(&state, &id).await.map_err(|e| e.to_string())
   }
   ```

   Returned and argument types derive `serde` and `specta::Type`, with
   snake_case fields.
3. **Register it** in `collect_commands!` inside `specta_builder()` in
   `src-tauri/src/lib.rs`. That list builds both the runtime handler and the
   bindings; there is no separate `invoke_handler` list to update.
4. **Regenerate bindings:** `just bindings` (runs
   `cargo test --test export_bindings`). Commit the updated
   `src/lib/bindings.ts`; CI regenerates it and fails on a stale copy.

## Frontend (`src/`)

5. **`src/lib/tauri-api.ts`:** add a method that wraps the generated call with
   `unwrap("<rust_name>", () => commands.<camelName>(...))`, so errors reject.
6. **Store action** in `src/stores/` that calls `api.<method>` and sets
   `loading`/`error`. Components call the action, never `api.*`.
7. **Mock handler** in `src/dev/mock/handlers/<area>.ts`, keyed by the Rust
   name, returning realistic fixture data. `src/dev/mock/__tests__/coverage.test.ts`
   fails without it, and fails on a handler for a command that no longer
   exists.

## Tests and gates

8. Store test for the new action (success and error), component test if the
   UI changed. `src/lib/__tests__/tauri-command-contract.test.ts` flags a Rust
   command nothing on the frontend calls.
9. Run the Rust and frontend gates from `AGENTS.md`. If the command touches a
   database path, also run the `integration-tests` skill.
10. Update the command list in section 5 of `docs/design/ARCHITECTURE.md`;
    `scripts/check-documented-commands.sh` fails CI when it disagrees with
    `src-tauri/src/lib.rs`.

For a rename or removal, do the same steps in reverse, and delete the mock
handler and the `api` method.
