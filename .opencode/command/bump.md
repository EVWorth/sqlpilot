---
description: Cut a new release version. Updates package.json + Cargo.toml + tauri.conf.json atomically, runs make bump, reports next steps.
agent: build
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
3. Compute new version (delegates to `make bump <type>` which has confirmation prompt):
   - `patch`: 0.3.4 → 0.3.5
   - `minor`: 0.3.4 → 0.4.0
   - `major`: 0.3.4 → 1.0.0
4. Suggest running `make bump <type>` — explain it has a Y/n confirmation prompt.
5. After bump, run version check to confirm consistency:
   ```bash
   jsver=$(node -p "require('./package.json').version")
   rsver=$(grep '^version' src-tauri/Cargo.toml | head -1 | sed 's/.*"\(.*\)".*/\1/')
   taver=$(node -p "require('./src-tauri/tauri.conf.json').version")
   [ "$jsver" = "$rsver" ] && [ "$jsver" = "$taver" ] && echo "All match: $jsver"
   ```
6. Report next steps:
   ```bash
   git add -A
   git commit -m "chore: bump version to <new>"
   git tag v<new>
   git push origin main --follow-tags
   ```
7. Note: tag push triggers `.github/workflows/release.yml` → cross-platform build + `latest.json` manifest.

## Pre-flight Checks

- Working tree clean (`git status --porcelain` empty)?
- On `main` branch?
- CI green on HEAD?

If any check fails, warn before bumping.

## Output

```
Version: 0.3.4 → 0.3.5 (patch)
Files updated:
  package.json
  src-tauri/Cargo.toml
  src-tauri/tauri.conf.json

Next:
  git add -A
  git commit -m "chore: bump version to 0.3.5"
  git tag v0.3.5
  git push origin main --follow-tags

Release: tag push triggers .github/workflows/release.yml
  - Builds: linux, windows (signed if cert), macos-arm, macos-x86
  - Generates latest.json update manifest
  - Draft release on GitHub (manual publish)
```

Don't run `git tag` or `git push` without explicit user approval. Bumping is reversible (just amend), tagging is harder.

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
