# Review checklist

What a review of a SQLPilot change looks for, beyond "does it do what the PR
says". Used by the `reviewer` agent, `/review-prs` and automated code review.
Project rules are in `AGENTS.md`; folder conventions in `src/CLAUDE.md` and
`src-tauri/CLAUDE.md`.

## Blocking

- **Correctness:** a concrete input or sequence that produces a wrong result,
  a crash, lost user data or a hang.
- **IPC contract:** a component calling `api.*` directly; a command missing
  from `collect_commands!`; `src/lib/bindings.ts` edited by hand or not
  regenerated; a missing mock handler; camelCase fields against snake_case
  Rust.
- **Errors:** an async error swallowed (empty `catch`, `.ok()` dropped,
  `let _ =` on a `Result` that matters); a store action without
  loading/error handling; `unwrap()`, `expect()` or `panic!` on a production
  path.
- **Security:** SQL built by string concatenation from user input where a
  parameter or quoting helper exists; user input reaching a shell, `eval` or
  `Function`; a CSP or Tauri permission change without a matching
  `docs/SECURITY.md` update; a secret, token or personal information in code,
  fixtures, commits or the PR.
- **Gates:** a CI gate, lint rule or test disabled, skipped or weakened to get
  green.
- **Hygiene:** version drift between the three manifests; a dependency change
  without its regenerated lockfile; a hand-edited lockfile; an app import
  using the test-only `@/` alias.

## Worth flagging, not blocking

- New exported logic or a new component without tests, or tests that cover
  only the happy path.
- `as`, `!` or `any` without a reason; `unsafe` without a soundness comment.
- Blocking I/O inside an async Rust function (use `spawn_blocking`).
- Hook dependency arrays that are wrong or effects without cleanup.
- State duplicated where it could be derived; components far over 300 lines.
- Missing labels, roles or visible focus on interactive elements.
- A comment or doc the change made untrue.
- A new workspace dependency outside `[workspace.dependencies]`.

## Don't flag

Formatting (dprint and rustfmt fix it), import order, naming taste, or "could
be shorter" without a concrete better version.

## Output

One line per finding, most severe first, ending with a verdict:

```
<file>:L<line>: <emoji> <severity>: <problem>. <fix>.
```

🔴 `bug` blocks merge · 🟠 `risk` likely bug under some usage · 🟡 `style`
convention break · 🟢 `nit` taste · 🔵 `q` question for the author.
Every finding names a concrete fix; critique without one is noise.
