---
description: Cut a new release version. Updates package.json + Cargo.toml + tauri.conf.json atomically, runs just bump, reports next steps.
argument-hint: "[patch|minor|major]"
---

Cut a new release version for SQLPilot. Updates all three version files atomically, verifies consistency, reports git/tag/release flow.

## Inputs

- `$ARGUMENTS` — bump type: `patch` (default), `minor`, or `major`. Optional.

## Process

1. Read current versions from all three files:
   ```bash
   node -p "require('./package.json').version"
   grep '^version' src-tauri/Cargo.toml | head -1
   node -p "require('./src-tauri/tauri.conf.json').version"
   ```
2. Confirm they're consistent. If not, ABORT and tell user to fix drift manually.
3. Compute new version (delegates to `just bump <type>` which has confirmation prompt):
   - `patch`: 0.3.4 → 0.3.5
   - `minor`: 0.3.4 → 0.4.0
   - `major`: 0.3.4 → 1.0.0
4. Suggest running `just bump <type>` — explain it has a Y/n confirmation prompt.
5. After bump, run version check to confirm consistency:
   ```bash
   jsver=$(node -p "require('./package.json').version")
   rsver=$(grep '^version' src-tauri/Cargo.toml | head -1 | sed 's/.*"\(.*\)".*/\1/')
   taver=$(node -p "require('./src-tauri/tauri.conf.json').version")
   [ "$jsver" = "$rsver" ] && [ "$jsver" = "$taver" ] && echo "All match: $jsver"
   ```
6. Report next steps:
   ```bash
   git switch -c release/<new>
   git add -A
   git commit -m "release: <new>"
   git push -u origin release/<new>   # open the release PR, get CI green, merge
   git fetch origin main
   git tag -a v<new> -m "SQLPilot <new>" origin/main   # the merge commit
   git push origin v<new>
   ```
7. Note: the tag push triggers `.github/workflows/release.yml` → cross-platform build, `latest.json` manifest and a draft release. Follow the whole flow in `CLAUDE.md` (Release Flow).

## Pre-flight Checks

- Working tree clean (`git status --porcelain` empty)?
- On `main` branch?
- CI green on HEAD?

If any check fails, warn before bumping.

## Output

```
Version: 0.3.4 → 0.3.5 (patch)
Files updated:
  package.json, package-lock.json
  src-tauri/Cargo.toml, src-tauri/Cargo.lock
  src-tauri/tauri.conf.json

Next:
  release PR with the bump → CI green → merge
  git tag -a v0.3.5 on the merge commit, git push origin v0.3.5

Release: tag push triggers .github/workflows/release.yml
  - Builds: linux, windows (signed if cert), macos-arm, macos-x86
  - Generates latest.json update manifest
  - Draft release on GitHub; publish once every build is attached
```

Never push to `main`: the bump goes through a release PR. Tag only the merged release commit. Once the maintainer has asked for a release, that covers the tag too (`CLAUDE.md`, Working agreements).

## Rollback

If bump was wrong before commit:

```bash
git checkout -- package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
```

If committed but not tagged:

```bash
git reset --soft HEAD~1
git restore --staged package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
git checkout -- package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
```

If tagged but not pushed: `git tag -d v<version>`. If pushed: never delete remote tags without team-lead approval (force-push main is forbidden).
