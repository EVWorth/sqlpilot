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
# Confirm ALL 4 builds + upload + generate-update-manifest succeed.

# If a build fails (lost runner, flaky test, etc.):
git tag -d v<NEW_VERSION>
git push origin :refs/tags/v<NEW_VERSION>
# fix, re-bump if needed, then re-tag

# Final verification:
gh release view v<NEW_VERSION> --json assets | \
  python3 -c "import json,sys; d=json.load(sys.stdin); \
    print(f'{len(d[\"assets\"])} assets'); \
    [print(' ', a['name']) for a in sorted(d['assets'], key=lambda x: x['name'])]"
```

Expected output: 17+ assets including `latest.json`, `*.AppImage`, `*.deb`, `*x86_64.rpm` (Linux), `*aarch64.dmg` + `*x64.dmg` (macOS), `*x64-setup.exe` + `*x64_en-US.msi` (Windows), `SQLPilot.exe` (Windows portable).

---

## Release workflow architecture

The release pipeline splits build from release-creation to keep creation single-sourced:

- `build` job (matrix) — runs `tauri build` only, no release. Uploads bundles + `.sig` to GH artifact store via `actions/upload-artifact@v7`.
- `upload` job (single ubuntu-22.04) — downloads all build artifacts, then `softprops/action-gh-release@v2` creates the draft release ONCE and uploads all assets.
- `generate-update-manifest` job runs after `upload` so `gh release download` sees the release.

tauri-action's "build only" mode is achieved by omitting `tagName`, `releaseName`, and `releaseId` (per the action's README). The signing key is still passed to the build step because tauri itself signs during `tauri build` when `bundle.createUpdaterArtifacts: true`.

**Verify after each release.** Confirm exactly one release exists for the tag:

```bash
gh api repos/EVWorth/sqlpilot/releases | \
  jq '.[] | select(.tag_name == "v<X.Y.Z>") | {id, name, draft, assets: (.assets | length)}'
# Expect: exactly one entry, draft=true, ~17 assets.
```

---

## Release pipeline gotchas

### 1. `bundle.createUpdaterArtifacts: true` requires the signing key on the BUILD step

**Symptom.** All 4 builds fail at the build step:

> A public key has been found, but no private key. Make sure to set TAURI_SIGNING_PRIVATE_KEY environment variable.
> [error]Command "npm [\"run\",\"tauri\",\"build\",\"--\",\"--target\",\"...\"]" failed with exit code 1

**Root cause.** When `tauri.conf.json` has `bundle.createUpdaterArtifacts: true`, `tauri-action@v1.0.0` signs artifacts **during `tauri build`** — not just during the manifest-generation step. The `TAURI_SIGNING_PRIVATE_KEY` env var must be on the build step's `env:` block, not just the manifest step's.

**Current shape:**

```yaml
- name: Build bundles (no release)
  uses: tauri-apps/tauri-action@<sha> # v1.0.0
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ""
  with:
    args: ${{ matrix.args }}
```

**Detecting.** When `createUpdaterArtifacts` is true and the key is missing, the bundler exits with `A public key has been found, but no private key.` The `dist/assets/` dir may be empty.

---

### 2. `linux-rpm` platform key in `latest.json`

**Symptom.** App installed via `.rpm` on Fedora/Bazzite. Status bar never shows an update chip. The `.rpm` is built and uploaded to the release (12 MB), but `latest.json` only lists `linux-x86_64` (AppImage) and `linux-deb`.

**Root cause.** `release.yml`'s bash manifest generator must have a `*_x86_64.rpm` case branch. The default `*` skips silently and the `.rpm` is left orphaned.

**Current shape:**

```bash
case "$base" in
  *_amd64.AppImage)     key="linux-x86_64" ;;
  *_amd64.deb)          key="linux-deb" ;;
  *aarch64.rpm)         key="linux-aarch64" ;;
  *x86_64.rpm)          key="linux-rpm" ;;
  ...
esac
```

**Pattern note.** Tauri's `.rpm` filename uses period before arch (`SQLPilot-0.4.0-1.x86_64.rpm`). `.deb` uses underscore (`SQLPilot_0.4.0_amd64.deb`). Different conventions — patterns differ.

---

### 3. `tauri.conf.json` `bundle.linux.deb.depends` / `rpm.depends` for clean installs

**Symptom.** User runs `apt install ./SQLPilot_0.4.0_amd64.deb` on a minimal Debian system. Transaction fails with unsatisfiable deps. Or `rpm-ostree install ./SQLPilot-0.4.0-1.x86_64.rpm` on minimal Bazzite triggers an interactive dependency transaction.

**Current shape:**

```json
"linux": {
  "deb": { "depends": ["libwebkit2gtk-4.1-0", "libgtk-3-0", "librsvg2-common"] },
  "rpm": { "depends": ["webkit2gtk4.1", "gtk3", "librsvg2"] }
}
```

Note: these match what tauri-action's own CI matrix uses, so they're verified.

---

### 4. Tag a fresh commit, not a re-pushed existing one

If the previous tag-push produced a partial / broken release, simply pushing the same SHA again does nothing. GitHub doesn't re-trigger the workflow on a tag that already exists.

```bash
# Delete + re-push
git tag -d v0.4.0
git push origin --delete v0.4.0
# Re-tag (now points to the same commit; workflow re-triggers)
git tag v0.4.0
git push origin v0.4.0
```

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
[ ] upload job: SUCCESS (one draft release created)
[ ] generate-update-manifest job: SUCCESS
[ ] gh release view v<X.Y.Z> --json assets shows >=17 assets
[ ] gh release view v<X.Y.Z> --json assets | jq '.assets[].name' | grep -E '\.(AppImage|deb|rpm|dmg|msi|exe)$'
    → all 4 platform families present
[ ] gh api repos/EVWorth/sqlpilot/releases | jq '.[] | select(.tag_name == "v<X.Y.Z>") | .draft'
    → exactly ONE release for the tag, draft=true
[ ] latest.json has linux-x86_64-rpm key
[ ] (Optional but recommended) Manual smoke test of update from previous version
```
