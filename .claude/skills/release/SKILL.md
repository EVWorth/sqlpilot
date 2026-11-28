---
name: release
description: Cut a SQLPilot release end to end by merging the standing release PR from dev into main, then watching auto-release.yml bump, tag, build and publish. Use when the maintainer says "release", "cut a release" or "ship it".
---

# Release

"Release" means ship it, end to end. Don't stop to ask whether to go ahead.
Nobody bumps, tags or publishes by hand: CI does all three when the release PR
merges. The pipeline and its failure modes are in `docs/RELEASING.md`; read it
before touching `auto-release.yml`, `release-pr.yml` or `release.yml`.

## 1. Find the release PR

It is the one open PR from `dev` to `main`, kept up to date by
`release-pr.yml`. Its title names the version the merge will release
(`Release v1.6.0`) and its body holds that changelog. The version comes from
the conventional commits on `dev` since the last tag; to change it, change the
commits (e.g. land a `feat!:` PR into `dev`), never the version files.

If the title says there is nothing to release, there are only `docs:`, `ci:`,
`chore:` and similar commits. Say so; merging it would only sync `main`.

No release PR while `dev` is ahead of `main` means `release-pr.yml` failed or
never ran: run it with `workflow_dispatch` (`actions_run_trigger`) and read
its log.

## 2. Get it green

The release PR's checks come from two CI runs on the same `dev` commit: the
push run, and a `pull_request` run against `main`. A red check is fixed
through a PR into `dev`, which moves the release PR with it. A new
`cargo audit` or `npm audit` advisory is fixed the same way, not deferred.

**Dependency age** in the `pull_request` run compares against `main`, so it
checks every version added since the last release again. A version that
went into `dev` under the `dependency-age-exception` label fails again
here until it is 7 days old. Tell the maintainer which versions it names;
the release waits until they label the release PR or the versions age.

## 3. Merge with a merge commit

Merge with `merge_method: "merge"`, **never squash**. Commitizen reads every
commit from `dev`; a squash leaves one commit it cannot use and splits the
history of `dev` and `main`. `auto-release.yml` refuses to release a squash.

## 4. Watch `Auto release`

The push to `main` starts `.github/workflows/auto-release.yml`:

1. `bump`: commitizen bumps the five version files, prepends `CHANGELOG.md`,
   commits `release: X.Y.Z` and pushes it and the `vX.Y.Z` tag to `main`.
2. `release`: `release.yml` validates the tag, runs the database integration
   tests, builds four platforms (Linux, Windows, macOS arm64 and x64), uploads
   them and `latest.json` to one release, then publishes it.
3. `sync-dev`: merges `main` back into `dev`.

The whole run takes about half an hour, most of it the integration tests
and the four builds. Don't poll it: schedule one check-in for about 30
minutes after the merge, and another for a few minutes later if the last
jobs are still running.

When it finishes, run `node scripts/verify-release.mjs X.Y.Z`. It checks that
there is one release for the tag, that it is published, that every
platform's assets and signatures are attached, and that `latest.json` names
the version and every updater key. Then confirm `dev` has the
`release: X.Y.Z` commit. If a job fails, diagnose with the
`ci-doctor` agent and follow "When a release fails" in `docs/RELEASING.md`.
Re-pushing a tag needs the maintainer: cloud sessions get HTTP 403 on tag
pushes. Never delete a published release or its tag without the maintainer.
