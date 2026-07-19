# Fix 204 — Cargo-Audit Advisories

Branch: `fix/204-cargo-audit-advisories`
Issue: #204
Goal: 100% of advisories cleared with **zero** `--ignore` flags, then re-add `cargo-audit` to PR CI.

## Status

- [x] **Phase 0:** Set up branch + plan
- [ ] **Phase 1:** Quick wins (low risk)
  - [ ] rustls + rustls-webpki bump (3 advisories)
  - [ ] quick-xml bump (2 advisories)
  - [ ] crossbeam-epoch bump (1 advisory)
  - [ ] **user: manual test** (cargo build, app launch)
- [ ] **Phase 2:** Medium (may have API surface)
  - [ ] tauri bump (within 2.x)
  - [ ] sqlx bump (RUSTSEC-2024-0363)
  - [ ] **user: manual test** (full app, IPC chain, query execution)
- [ ] **Phase 3:** Hard (unmaintained gtk-rs)
  - [ ] Research: fork / GTK4 / patch.crates-io
  - [ ] Implement chosen approach
  - [ ] **user: manual test** (full build + dev + production)
- [ ] **Phase 4:** Re-add `cargo-audit` to PR CI
- [ ] **Phase 5:** Final CI run + PR

## Per-Phase Worktree Strategy

Each phase lives on a sub-branch off `fix/204-cargo-audit-advisories` to isolate risk. Merge back when phase is green.

## Test Plan

After each phase:

- `cargo build --workspace`
- `cargo test --workspace`
- `cargo clippy --workspace -- -D warnings`
- `cargo audit` (decreasing count expected)
- **user: app launch + click through core flows**

## Notes

- No `--ignore` flags allowed in final state
- No version pins in `Cargo.toml` to silence warnings
- Each fix as separate commit for reviewability
- No PR until all phases done + user confirms
