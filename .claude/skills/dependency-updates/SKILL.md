---
name: dependency-updates
description: Work through the open dependency PRs for SQLPilot (Dependabot's npm, cargo and GitHub Actions updates, and the weekly dprint plugin PR) and merge them in a safe order. Use when the maintainer says "handle the dependabot PRs", "merge the dependency updates", or before a release when such PRs are open.
---

# Dependency updates

Merge what is safe, fix what is broken at its cause, and leave Dependabot to
rebuild its own branches. Never copy a Dependabot lockfile into your own
branch: it was resolved against an older `dev` and silently undoes whatever
merged since (it once took `jsdom` back from 31 to 30).

## 1. List them

Open PRs into `dev` by `dependabot[bot]` or `github-actions[bot]` (the dprint
plugin PR). Ignore the release PR into `main`. For each: title, files, head
SHA, `mergeable_state`, and its check runs on the head SHA.

## 2. Triage each one

| Case                                   | What to do                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CI green, including **Dependency age** | Merge (squash).                                                                                                                                                                                                                                                                                                                                                    |
| **Dependency age** failed              | The PR adds a version under 7 days old, usually one its lockfile pulled in rather than the one it names. Leave it. Once the job's listed versions are 7 days old, comment `@dependabot recreate`. Do not label it `dependency-age-exception`: that label is for urgent security fixes, and only the maintainer adds it.                                            |
| Another check failed                   | Read the log. If the update broke something, fix the cause in a PR of your own into `dev` (with an issue, per `AGENTS.md`), merge it, then comment `@dependabot rebase` on the dependency PR. If the failure is not the PR's (red on `dev` too), fix `dev` first the same way.                                                                                     |
| `mergeable_state` dirty or behind      | Comment `@dependabot rebase` and wait for the new head's CI.                                                                                                                                                                                                                                                                                                       |
| The dprint plugin PR                   | Opened by Actions, so CI never runs on it. If it is behind `dev`, run `dprint-update.yml` on `dev` (`workflow_dispatch`); it rebuilds the same branch and PR. Then check it out in a worktree and run `npx dprint check --list-different` and `npm run type-check` there, and confirm each plugin version in `dprint.json` is at least 7 days old. Merge if clean. |
| A major version                        | CI must be green, and read the release notes linked in the PR for breaking changes that the tests would not show (config formats, removed options, runtime behaviour).                                                                                                                                                                                             |

## 3. Merge order

1. GitHub Actions bumps (one workflow file each; confirm the pinned SHA is
   the tag's commit, `scripts/check-action-pins.sh` does this in CI).
2. Single-package updates.
3. Group updates.
4. The dprint plugin PR last, so it formats the code as it ends up.

After each merge that touches `package-lock.json` or `src-tauri/Cargo.lock`,
the other PRs touching that file go stale: comment `@dependabot rebase` on
each and wait for green before merging the next.

When Dependabot does not act on a command within a few minutes (it has
ignored `@dependabot rebase` before, perhaps because of the footer every
comment carries), don't keep asking. For a PR whose CI predates a check, fetch
its branch into a worktree and run that check there, for example
`node <main checkout>/scripts/check-dependency-age.mjs --base origin/dev`, and
merge on the result if every other check is green. Otherwise close it and
let Dependabot open it again on its next run.

## 4. Checking ages yourself

`node scripts/check-dependency-age.mjs --base origin/dev` lists every package
version the working tree's lockfiles add over `dev` that is under 7 days old.
CI runs the same script as the **Dependency age** job. In a cloud container,
npm may be older than the version `.node-version` pins and ignore `.npmrc`'s
`min-release-age`, so run this before committing any lockfile change.

## 5. Report

A table: each PR, what it updates, and what happened (merged, waiting for a
version to age, fixed in #N, rebased). Then, if the maintainer asked for it,
cut the release with the `release` skill.
