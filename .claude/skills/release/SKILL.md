---
name: release
description: Cut a SQLPilot release end to end — pick the version, bump the three manifests, open and merge the release PR, tag the merge commit, watch release.yml and publish the draft. Use when the maintainer says "release", "cut a release", "ship it" or "bump the version".
argument-hint: "[patch|minor|major]"
---

# Release

"Release" means ship it, end to end. Don't stop to ask which version or whether
to go ahead. Pitfalls in the pipeline itself (signing key, rpm manifest, re-tag
protocol) are in `docs/RELEASING.md`; read it before touching `release.yml`.

## 1. Pick the version

Use `$ARGUMENTS` if given. Otherwise compare against the last tag:

```bash
git fetch origin main --tags
last=$(git describe --tags --abbrev=0 origin/main)
git log "$last"..origin/main --pretty=%s --no-merges
```

Any `feat:` subject means **minor**; only fixes and chores mean **patch**.
**Major** only when the maintainer says so.

## 2. Bump in a release PR

From a clean checkout of `origin/main` (in a cloud session, reset the session
branch to `origin/main`):

```bash
bash scripts/check-release-readiness.sh --strict   # manifests agree, clean, on main
echo y | just bump <level>                         # the recipe asks to confirm
bash scripts/check-release-readiness.sh <new>      # all three now say <new>
```

`just bump` updates `package.json`, `src-tauri/Cargo.toml`,
`src-tauri/tauri.conf.json` and the app's own entries in both lockfiles.
`--strict` exits 4 off `main`; in a cloud session run it without `--strict`
and check `git status` yourself.

Commit as `release: <new>` and open the PR. Get CI green. A new
`cargo audit` or `npm audit` advisory is fixed in this same PR
(`cargo update -p <crate>`, `npm audit fix`), not deferred. Merge the PR.

## 3. Tag the merge commit

```bash
git fetch origin main
bash scripts/check-release-readiness.sh <new>      # on the merge commit
git tag -a v<new> <merge-sha> -m "SQLPilot <new>"
git push origin v<new>
```

**Cloud sessions can't push tags** (HTTP 403) and the GitHub tools can't
create them. Give the maintainer those exact commands, with the merge SHA
filled in, and say the draft will need publishing.

## 4. Watch the build and publish

The tag starts `.github/workflows/release.yml`. Its `validate` job fails fast
if the tag and manifests disagree. Then it builds four platforms (Linux,
Windows, macOS arm64 and x64), signs Windows when the certificate secrets
exist, uploads everything to one draft release and generates `latest.json`.

When the run finishes, check the draft has every platform's assets (the
expected list is in `docs/RELEASING.md`), then publish it. If a build fails,
diagnose with the `ci-doctor` agent and follow the re-tag protocol in
`docs/RELEASING.md`. Never delete a published release or a pushed tag without
the maintainer.
