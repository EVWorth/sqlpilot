# CI

How the automated workflows are set up, and the one-time configuration they
need. For cutting a release see [RELEASING.md](RELEASING.md).

## Workflows

| Workflow                                                      | Trigger                      | What it does                                                                      |
| ------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| [`ci.yml`](../.github/workflows/ci.yml)                       | PR to `main`, push to `main` | Lint, typecheck, format, test. Jobs are gated by changed paths.                   |
| [`release.yml`](../.github/workflows/release.yml)             | `v*` tag, manual dispatch    | Validates the tag against manifests, runs the database integration tests, builds. |
| [`dprint-update.yml`](../.github/workflows/dprint-update.yml) | Mondays 09:00 UTC, manual    | Bumps dprint plugins and opens a PR if anything drifted.                          |

## Path filters

The first job in `ci.yml`, `detect-changes`, runs `dorny/paths-filter` against
the PR's base and publishes one output per area. Every other job is gated on
those outputs, so a docs-only PR runs neither the Rust nor the frontend suite.

| Output      | Paths                                                                                             | Jobs it turns on                                         |
| ----------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `frontend`  | `src/**`, `package*.json`, `vitest*.config.ts`, `eslint.config.js`, `.node-version`, `ci.yml`     | `lint-ts`, `test-frontend`, `check-test-mocks`, `dprint` |
| `rust`      | `src-tauri/**`, `rust-toolchain.toml`, `ci.yml`                                                   | `lint-rust`, `test-rust`, `check-docs`                   |
| `npm`       | `package.json`, `package-lock.json`                                                               | `npm-audit`, `check-versions`                            |
| `cargo`     | `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`                                                    | `cargo-audit`, `check-versions`                          |
| `docs`      | `docs/**`, `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `REVIEW.md`, `**/CLAUDE.md`, `.claude/**` | `check-docs`, `dprint`                                   |
| `workflows` | `.github/workflows/**`, `scripts/**`, `justfile`                                                  | `lint-workflows`, `check-docs`, `check-test-mocks`       |
| `config`    | `lefthook.yml`, `eslint.config.js`, `dprint.json`, `vitest*.config.ts`                            | `dprint`                                                 |

`ci.yml` is in both `frontend` and `rust` so that editing the workflow runs
the jobs it defines. The `dprint` job checks only the files the PR changed.
Root files outside every filter trigger no job at all.

## Workflow lint

A PR touching any workflow file or anything under `scripts/` runs
`Lint (workflows)`: actionlint plus
[`scripts/check-action-pins.sh`](../scripts/check-action-pins.sh), which
verifies every pinned action SHA is 40 hex characters, resolves upstream, and
matches the version comment beside it. That check exists because a
41-character pin once sat in `dprint-update.yml` and failed every scheduled
run for months without anyone noticing (#534). The same job runs the tests for
the release scripts (update manifest builder, cargo-audit gate, Tauri version
check).

Run the same checks locally with `just lint-workflows`.

## Automation identity

`dprint-update.yml` opens its PR as **GitHub Actions**, using `GITHUB_TOKEN`.
That requires one repository setting, which is already on:

_Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to
create and approve pull requests"_

No secrets, no App, nothing to rotate.

### What that setting costs

Two things, recorded so neither is rediscovered the hard way.

**It also lets Actions approve pull requests.** The switch bundles create and
approve together. `main` has no branch protection today, so this grants nothing
in practice — but the day required reviews are added, an approving review from
`GITHUB_TOKEN` would satisfy them. If branch protection ever goes on `main`,
revisit this.

**The bump PR gets no checks.** GitHub does not run workflows for a pull request
opened with `GITHUB_TOKEN`, to prevent recursion. The job compensates by running
`npx tsc --noEmit` and the unit suite against the reformatted tree before opening
the PR, and the PR body says so. To get the full matrix on one, push an empty
commit to its branch.

### The alternative, if either cost stops mattering

A GitHub App installation token is subject to neither restriction: the repository
setting becomes irrelevant and the PR runs CI normally. It costs one App to
create and a private key to hold. See [#537](https://github.com/EVWorth/sqlpilot/issues/537)
for the comparison; the workflow was briefly written that way and the shape is in
its history.

Worth switching if branch protection lands on `main`, or if a bump ever breaks
something the pre-open verification does not catch.
