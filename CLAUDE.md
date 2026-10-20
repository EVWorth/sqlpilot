# SQLPilot: notes for Claude

## Working agreements

These come from the maintainer. Follow them without asking again.

- **"Release" means ship it, end to end.** Don't stop to ask which version or
  whether to go ahead. Bump the version (a minor version when features landed,
  a patch when only fixes did). Open the release PR. Get CI green, fixing any
  new advisories in the same PR. Merge it, tag `v<version>` on the merge
  commit, and follow `release.yml` through to the published release. The
  steps and the pipeline's pitfalls are in `docs/RELEASING.md`.
- **Anything wrong gets an issue.** A failing check, a broken test setup, a
  regression, a stale comment, a gap in CI: file a GitHub issue for it as
  soon as you find it, even when it is outside the task at hand. Include the
  command that shows it, its output, the cause if you know it, and a fix.
  Don't widen the current PR to cover it.
- **Write lasting instructions down here.** When the maintainer sets a rule
  for how to work, add it to this file in the same session.

## Checks before pushing

- `cd src-tauri && cargo fmt --all --check` and
  `cargo clippy --workspace --all-targets -- -D warnings`. CI's clippy step
  lints only the app crate, not `crates/mas-*` (#772). Lint the whole
  workspace yourself.
- Unit tests: `just test-rust`, `just test-frontend`.
- Anything touching the connection manager, executor, schema inspector,
  backup/restore or admin: `just db-up`, then `just test-integration` against
  MySQL (port 13306) and again with `MAS_TEST_PORT=13308` for MariaDB. CI
  runs these only at release time.
- `npx dprint check` for docs and config.

## Cloud sessions

- The session's git access pushes only to its own branch. **Tag pushes are
  cut off** ("the remote end hung up unexpectedly"), and the GitHub tools
  cannot create tags or publish releases. For a release, merge the PR, then
  give the maintainer the exact `git tag -a` / `git push origin v<version>`
  commands and say the draft release needs publishing.
- Once a PR merges, GitHub deletes the session branch. Recreate it
  from `origin/main`.
- The disk fills quickly with test binaries. Before a long test run, delete
  `src-tauri/target/debug/incremental` and the large executables in
  `src-tauri/target/debug/deps`, and run with `CARGO_INCREMENTAL=0`.
- Docker doesn't survive a container restart. Start `dockerd`, then
  `just db-up`.
- `src/__tests__/main.test.tsx` times out in the container and passes in CI.
  The `mas-mcp` endpoint tests panic when built together with the app crate
  (#773).
