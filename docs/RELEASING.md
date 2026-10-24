# Releasing SQLPilot

End-to-end checklist and hard-won lessons for cutting a release. Updated
whenever a new gotcha surfaces. The short form is also in `CLAUDE.md` (Release
Flow).

---

## TL;DR

```bash
# 1. From a clean, up-to-date main
git checkout main && git pull
bash scripts/check-release-readiness.sh --strict

# 2. Bump: minor if features landed, patch if only fixes
git checkout -b release/<NEW_VERSION>
just bump minor        # package.json, tauri.conf.json, Cargo.toml and both lockfiles
git commit -am "release: <NEW_VERSION>"
git push -u origin release/<NEW_VERSION>
# Open the release PR and get CI green. Fix any new advisories in this PR.

# 3. Merge the PR, then on the merge commit
git checkout main && git pull
bash scripts/check-release-readiness.sh <NEW_VERSION>

# 4. Tag the merge commit and push the tag (triggers release.yml)
git tag -a v<NEW_VERSION> -m "v<NEW_VERSION>"
git push origin v<NEW_VERSION>

# 5. Watch https://github.com/EVWorth/sqlpilot/actions/workflows/release.yml
#    validate → integration-db → build (4 platforms) → upload → generate-update-manifest

# 6. The workflow leaves a DRAFT release. Publish it once every platform's
#    build is attached and latest.json is there:
gh release view v<NEW_VERSION> --json assets -q '.assets[].name'
gh release edit v<NEW_VERSION> --draft=false
```

The four builds are Linux x86_64 (`.AppImage`, `.deb`, `.rpm`), Windows
x86_64 (`.msi`, `-setup.exe`, portable `SQLPilot.exe`), macOS Apple Silicon
and macOS Intel (`.dmg` and `.app.tar.gz` each), plus a `.sig` beside every
updater artifact and `latest.json`.

If a build fails (lost runner, flaky test), see gotcha 4 for the re-tag
protocol.

---

## Release workflow architecture

The release pipeline splits build from release-creation to keep creation single-sourced:

- `validate` job — `scripts/check-release-readiness.sh <tag version>` fails fast if the tag does not match the manifests.
- `integration-db` job — the `#[ignore]`d database tests against MySQL 8 and MariaDB 11, plus coverage. `build` depends on it, so a database regression blocks the release.
- `build` job (matrix of 4) — runs `tauri build` only, no release. Uploads bundles + `.sig` to the artifact store via `actions/upload-artifact`.
- `upload` job (single ubuntu-22.04) — downloads all build artifacts, then `softprops/action-gh-release` creates the draft release ONCE and uploads all assets.
- `generate-update-manifest` job runs after `upload` so `gh release download` sees the release. It runs [`scripts/build-update-manifest.sh`](../scripts/build-update-manifest.sh) and uploads `latest.json`. It has no signing key: it reads the `.sig` files the build produced.

tauri-action's "build only" mode is achieved by omitting `tagName`, `releaseName`, and `releaseId` (per the action's README). The signing key is still passed to the build step because tauri itself signs during `tauri build` when `bundle.createUpdaterArtifacts: true`.

**Verify after each release.** Confirm exactly one release exists for the tag:

```bash
gh api repos/EVWorth/sqlpilot/releases | \
  jq '.[] | select(.tag_name == "v<X.Y.Z>") | {id, name, draft, assets: (.assets | length)}'
# Expect: exactly one entry, draft=true until you publish it.
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

### 2. Every updater platform key in `latest.json`

**Symptom.** App installed via `.rpm` on Fedora/Bazzite. The status bar never
shows an update chip, although the `.rpm` is on the release.

**Root cause.** The updater looks up `{os}-{arch}-{installer}` first
(`appimage`, `deb`, `rpm`, `app`, `msi`, `nsis`) and `{os}-{arch}` as a
fallback. A missing suffixed key means an `.rpm` or `.deb` install finds
nothing for its own installer. #572 removed the suffixed keys believing
nothing read them; a 1.0.0 log searching for `linux-x86_64-rpm` proved
otherwise, and #691 put them back.

**Current shape.** [`scripts/build-update-manifest.sh`](../scripts/build-update-manifest.sh)
maps each of the eleven keys to a filename glob, requires exactly one match
per glob, and checks the written manifest against the expected key set. Its
test is `scripts/test-build-update-manifest.sh`, run by CI's
`lint-workflows` job.

**Pattern note.** Tauri's `.rpm` filename uses a period before the arch
(`SQLPilot-0.4.0-1.x86_64.rpm`); `.deb` uses an underscore
(`SQLPilot_0.4.0_amd64.deb`).

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

### 4. Re-tag protocol

If a tag push produced a partial or broken release, pushing the same tag again
does nothing: GitHub does not re-trigger the workflow for a tag that already
exists. Delete the draft release, delete the tag, then re-tag.

```bash
gh release delete v<X.Y.Z> --yes          # the draft, if one was created
git tag -d v<X.Y.Z>
git push origin --delete v<X.Y.Z>
# If a fix is needed, land it through a PR first and tag the new merge commit.
git tag -a v<X.Y.Z> -m "v<X.Y.Z>"
git push origin v<X.Y.Z>
```

---

## Release cut checklist

```
[ ] All PRs queued for this release are merged to main
[ ] bash scripts/check-release-readiness.sh --strict      (clean main)
[ ] just bump <minor|patch>; release PR opened; CI green; merged
[ ] bash scripts/check-release-readiness.sh <X.Y.Z>       (on the merge commit)
[ ] git tag -a v<X.Y.Z> on the merge commit; tag pushed
[ ] validate, integration-db: SUCCESS
[ ] All 4 build jobs: SUCCESS
[ ] upload job: SUCCESS (one draft release created)
[ ] generate-update-manifest job: SUCCESS (latest.json attached)
[ ] gh release view v<X.Y.Z> --json assets -q '.assets[].name'
    → AppImage, deb, rpm, msi, setup.exe, SQLPilot.exe, two dmg, two app.tar.gz, .sig files, latest.json
[ ] gh api repos/EVWorth/sqlpilot/releases | jq '.[] | select(.tag_name == "v<X.Y.Z>") | .draft'
    → exactly ONE release for the tag
[ ] Draft published
[ ] (Optional but recommended) Manual smoke test of update from previous version
```

## What the v1.0.0 cut ran into

Six tags. The release pipeline was rewritten in July — build split from
upload — and v0.4.0 was cut two days before that landed, so v1.0.0 was the
first release to execute any of it. Every failure below was waiting in `main`
for someone to try:

| Failure                                    | Cause                                                                                                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coverage step failed, blocking every build | `--include-ignored` reached the live agent tests, and the database suites ran in parallel and dropped each other's fixtures                              |
| Both macOS builds: "No files were found"   | The bundles go to `target/<triple>/release/bundle` when `--target` is passed; the upload looked in `target/release/bundle`                               |
| Windows: toolchain install failed in 19s   | `$(sed ...)` and `$GITHUB_OUTPUT` are bash, and Windows runners default to PowerShell. The step "succeeded" having written nothing                       |
| Update manifest refused to write           | Tauri now names the updater bundle `SQLPilot.app.tar.gz` with no architecture, so both macOS jobs produced the same filename and one overwrote the other |
| Upload rejected a glob                     | A `#` comment inside a YAML block scalar is a line, not a comment — self-inflicted, twenty minutes old                                                   |

Two lessons worth keeping. **Cut a release after changing the release
workflow**, even a no-op one — every one of these was invisible until the
pipeline actually ran. And the loud failures earned their keep:
`if-no-files-found: error` and the manifest's refusal to guess are what turned
four silent partial releases into four red jobs.
