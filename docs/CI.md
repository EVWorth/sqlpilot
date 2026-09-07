# CI

How the automated workflows are set up, and the one-time configuration they
need. For cutting a release see [RELEASING.md](RELEASING.md).

## Workflows

| Workflow                                                      | Trigger                      | What it does                                                                      |
| ------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| [`ci.yml`](../.github/workflows/ci.yml)                       | PR to `main`, push to `main` | Lint, typecheck, format, test. Jobs are gated by changed paths.                   |
| [`release.yml`](../.github/workflows/release.yml)             | `v*` tag, manual dispatch    | Validates the tag against manifests, runs the database integration tests, builds. |
| [`dprint-update.yml`](../.github/workflows/dprint-update.yml) | Mondays 09:00 UTC, manual    | Bumps dprint plugins and opens a PR if anything drifted.                          |

`ci.yml` skips work it does not need: a docs-only PR runs neither the Rust nor
the frontend suite. A PR touching any workflow file runs `Lint (workflows)`,
which is actionlint plus
[`scripts/check-action-pins.sh`](../scripts/check-action-pins.sh) — the latter
verifies every pinned action SHA is 40 hex characters and resolves upstream.
That check exists because a 41-character pin once sat in `dprint-update.yml`
and failed every scheduled run for months without anyone noticing (#534).

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
