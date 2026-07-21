# Releasing SQLPilot

End-to-end checklist + hard-won lessons for cutting a release. Updated whenever a new gotcha surfaces.

---

## TL;DR

```bash
# On main, with no local changes
git checkout main && git pull

# Make sure all open PRs that should ship in this release are merged.
# If a release prep PR is open (e.g. release/0.4.0), merge it first.

# Bump the version
BUMP_TYPE=minor make bump
# confirm with `y`; or automate via the recipe in Makefile

# Commit
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
git commit -m "chore: bump version to <NEW_VERSION>"

# Tag + push (triggers the release workflow)
git tag v<NEW_VERSION>
git push origin v<NEW_VERSION>

# Watch the workflow:
#   https://github.com/EVWorth/sqlpilot/actions/workflows/release.yml
# Confirm ALL 4 builds + generate-update-manifest succeed.

# If a build fails (lost runner, flaky test, etc.):
git tag -d v<NEW_VERSION>
git push origin :refs/tags/v<NEW_VERSION>
# fix, re-bump if needed, then re-tag

# If release.yml produced two draft releases (race condition - see gotcha #1):
#   1. publish the one with all assets (likely the Draft)
#   2. delete the one with 2 assets (the broken Latest)

# Final verification:
gh release view v<NEW_VERSION> --json assets | \
  python3 -c "import json,sys; d=json.load(sys.stdin); \
    print(f'{len(d[\"assets\"])} assets'); \
    [print(' ', a['name']) for a in sorted(d['assets'], key=lambda x: x['name'])]"
```

Expected output: 17+ assets including `latest.json`, `*.AppImage`, `*.deb`, `*x86_64.rpm` (Linux), `*aarch64.dmg` + `*x64.dmg` (macOS), `*x64-setup.exe` + `*x64_en-US.msi` (Windows), `SQLPilot.exe` (Windows portable).

---

## Release pipeline gotchas

### 1. `tauri-action@v1.0.0` creates duplicate release candidates with strategy.matrix

**Symptom.** Tag-push triggers the release workflow. All 4 builds succeed. But after the run, GitHub shows two releases both tagged `vX.Y.Z`:

- One Draft with all assets (full set)
- One published "Latest" with only `latest.json` + `SQLPilot.exe` (Windows portable upload from the matrix's `Upload portable exe` step)

GitHub picks the partial one as the visible release. Linux/macOS users see no auto-update.

**Root cause.** `tauri-action@v1.0.0`'s `releaseDraft: true` mode in a strategy matrix has each parallel job race to create the draft release. The first wins; the others either create a SECOND draft or fail to find the existing release and silently lose their assets.

**Fix.** (issue #242)

- Option A: split into `build` (matrix) + `upload` (single ubuntu-latest) jobs. Upload job downloads artifacts via `actions/upload-artifact@v4` from each build job.
- Option B: a `concurrency: group: release-${{ github.ref_name }} cancel-in-progress: false` block on the workflow — but this serializes runs, doesn't help within a single run.

**Recovery when it happens.**

```bash
# Find the draft (the one with all assets)
gh api -X GET repos/EVWorth/sqlpilot/releases | \
  python3 -c "import json,sys; [print(r['id'], r['name'], len(r['assets']), r['draft']) for r in json.load(sys.stdin) if r['tag_name'] == 'vX.Y.Z']"
# Should show one Draft with ~17 assets and one Latest with ~2.

DRAFT_ID=<the one with ~17 assets>
LATEST_ID=<the one with ~2>

# Delete the broken Latest
gh api -X DELETE repos/EVWorth/sqlpilot/releases/$LATEST_ID

# Publish the Draft (now becomes the new Latest)
gh api -X PATCH repos/EVWorth/sqlpilot/releases/$DRAFT_ID -f draft=false
```

---

### 2. `bundle.createUpdaterArtifacts: true` requires the signing key on the BUILD step

**Symptom.** All 4 builds fail at the build step:

> A public key has been found, but no private key. Make sure to set TAURI_SIGNING_PRIVATE_KEY environment variable.
> [error]Command "npm [\"run\",\"tauri\",\"build\",\"--\",\"--target\",\"...\"]" failed with exit code 1

**Root cause.** When `tauri.conf.json` has `bundle.createUpdaterArtifacts: true` (the canonical flag added in #239), `tauri-action@v1.0.0` signs artifacts **during `tauri build`** — not just during the manifest-generation step. The workflow had `TAURI_SIGNING_PRIVATE_KEY` set only on the manifest step, missing the build step.

**Fix.** (PR #241) Add the env to the build step:

```yaml
- name: Build and publish
  uses: tauri-apps/tauri-action@<sha> # v1.0.0
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ""
  with:
    ...
```

**Detecting.** When `createUpdaterArtifacts` is true and the key is missing, the bundler exits with `A public key has been found, but no private key.` The `dist/assets/` dir may be empty.

---

### 3. `linux-rpm` platform key was silently absent from `latest.json` before #239

**Symptom.** App is installed via `.rpm` on Fedora/Bazzite. Status bar never shows an update chip. The `.rpm` is built and uploaded to the release (12 MB), but `latest.json` only lists `linux-x86_64` (AppImage) and `linux-deb`.

**Root cause.** `release.yml`'s bash manifest generator had no `*_x86_64.rpm)` case branch; the default `*` skipped silently. (issue from the 0.4.0 audit)

**Fix.** (PR #239) Add the case branch:

```bash
case "$base" in
  *_amd64.AppImage)     key="linux-x86_64" ;;
  *_amd64.deb)          key="linux-deb" ;;
  *aarch64.rpm)         key="linux-aarch64" ;;
  *x86_64.rpm)          key="linux-rpm" ;;     # NEW
  ...
```

**Pattern note:** Tauri-action's `.rpm` filename uses period before arch (`SQLPilot-0.4.0-1.x86_64.rpm`). `.deb` uses underscore (`SQLPilot_0.4.0_amd64.deb`). Different conventions — patterns differ.

---

### 4. `tauri.conf.json` `bundle.linux.deb.depends` / `rpm.depends` for clean installs

**Symptom.** User runs `apt install ./SQLPilot_0.4.0_amd64.deb` on a minimal Debian system. Transaction fails with unsatisfiable deps. Or `rpm-ostree install ./SQLPilot-0.4.0-1.x86_64.rpm` on minimal Bazzite triggers an interactive dependency transaction.

**Fix.** (PR #239) Declare runtime deps in `tauri.conf.json`:

```json
"linux": {
  "deb": { "depends": ["libwebkit2gtk-4.1-0", "libgtk-3-0", "librsvg2-common"] },
  "rpm": { "depends": ["webkit2gtk4.1", "gtk3", "librsvg2"] }
}
```

Note: these match what tauri-action's own CI matrix uses, so they're verified.

---

### 5. Tag a fresh commit, not a re-pushed existing one

If the previous tag-push produced a partial / broken release, simply pushing the same SHA again does nothing. GitHub doesn't re-trigger the workflow on a tag that already exists.

```bash
# Delete + re-push
git tag -d v0.4.0
git push origin --delete v0.4.0
# Re-tag (now points to the same commit; workflow re-triggers)
git tag v0.4.0
git push origin v0.4.0
```

This is how the v0.4.0 release was recovered after #241 fixed the signing-key issue.

---

## Release cut checklist (TL;DR form)

```
[ ] All PRs queued for this release are merged to main
[ ] Branch: main, working tree clean
[ ] Version bump PR opened, reviewed, merged
[ ] Pre-tag validation:
    bash scripts/check-release-readiness.sh --strict <NEW_VERSION>
[ ] Tag pushed
[ ] Workflow run URL bookmarked
[ ] All 4 build jobs: SUCCESS
[ ] generate-update-manifest job: SUCCESS
[ ] gh release view v<X.Y.Z> --json assets shows >=17 assets
[ ] gh release view v<X.Y.Z> --json assets | jq '.assets[].name' | grep -E '\.(AppImage|deb|rpm|dmg|msi|exe)$'
    → all 4 platform families present
[ ] latest.json has linux-x86_64-rpm key
[ ] (Optional but recommended) Manual smoke test of update from previous version
```

## Related

- Issue #242 — fix race condition
- Issue #243 — release-capture doc
- Issue #244 — Bazzite auto-updater broken
- PR #239 — linux-rpm manifest + bundle deps + min_app_version
- PR #241 — TAURI_SIGNING_PRIVATE_KEY on build step

## History of gotchas

- 0.4.0 — discovered gotchas 1, 2, 3, 4 above (race condition, signing key, rpm manifest gap, linux deps).
