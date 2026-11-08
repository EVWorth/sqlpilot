# Releasing SQLPilot

Releases are automatic: merging the release PR from `dev` into `main` cuts
one. Nobody bumps, tags or publishes by hand. This page covers how that works,
what to do when it fails, and the pipeline gotchas worth remembering.

---

## How a release happens

```
feature PR ──squash──▶ dev ──release PR, merge commit──▶ main ──▶ auto-release.yml
dependabot PR ─────────▶ dev                                      bump, tag, build, publish
                          ▲                                               │
                          └──────────────── main merged back ─────────────┘
```

1. **Every PR targets `dev`**, Dependabot and the dprint bump included. PRs
   into `dev` are squash-merged, so the PR title becomes the commit, and
   `pr-title.yml` checks it is a conventional commit.
2. **`release-pr.yml` keeps one PR open from `dev` to `main`.** On every push
   to `dev` it retitles the PR with the version merging it would release
   (`Release v1.6.0`) and puts that release's changelog in the body.
3. **Merge the release PR with "Create a merge commit", never squash.** That
   is the release decision; batch as much onto `dev` as you like first.
   `pr-title.yml` fails any PR into `main` that is not this one.
4. **`auto-release.yml` runs on the push to `main`.** Commitizen reads the
   conventional commits since the last tag and picks the version:

   | Commits since the last tag                  | Release          |
   | ------------------------------------------- | ---------------- |
   | `feat!:` or a `BREAKING CHANGE:` footer     | major            |
   | `feat:`                                     | minor            |
   | `fix:`, `perf:`, `refactor:`                | patch            |
   | only `docs:`, `ci:`, `chore:`, `test:`, ... | nothing released |

   It writes the version into the five files that record it
   ([`scripts/bump-version.sh`](../scripts/bump-version.sh)), prepends the
   section to [`CHANGELOG.md`](../CHANGELOG.md), commits `release: X.Y.Z` to
   `main` and pushes the `vX.Y.Z` tag with it, atomically.
5. **`release.yml` builds and publishes**, called directly by
   `auto-release.yml`: the tag check, the database integration tests, four
   platform builds, one release with every asset, `latest.json`, then
   publish. The release stays a draft until `latest.json` is attached, so the
   updater never sees a release without its manifest. The notes are the
   CHANGELOG section plus the downloads table.
6. **`main` is merged back into `dev`**, so `dev` carries the bump commit and
   the next release PR starts from it.

The configuration is [`.cz.toml`](../.cz.toml). The version source is the
latest tag (`version_provider = "scm"`); the files follow it. Commitizen is
pinned with hashes in
[`.github/release/requirements.txt`](../.github/release/requirements.txt).

To preview locally what the release PR would release:

```bash
pip install --require-hashes -r .github/release/requirements.txt
cz bump --get-next                         # next version, or exit 3/21: nothing to release
cz changelog --dry-run --incremental --unreleased-version "v$(cz bump --get-next)"
```

### One-time repository settings

These are settings, not files, so a PR cannot make them:

- **Default branch: `dev`.** New PRs then target it without anyone choosing,
  Dependabot reads its configuration from it, and Dependabot security updates,
  which ignore `target-branch`, land on it.
- **Merge methods:** allow merge commits (for the release PR) and squash
  merges (for everything into `dev`).
- **Actions may create pull requests** (Settings → Actions → General). The
  dprint bump already needs this.
- **If `main` has a branch ruleset, let GitHub Actions bypass it.** The bump
  commit and the tag are pushed to `main` with `GITHUB_TOKEN`.

### Pushes made with `GITHUB_TOKEN` start no workflows

That is why `auto-release.yml` calls `release.yml` instead of relying on its
tag trigger, and why the bump commit and the `dev` sync start no further runs.
It also means the release PR, opened by Actions, gets no `pull_request` runs:
its checks come from CI's push run on the same `dev` commit.

---

## When a release fails

Read the failing job first (the `ci-doctor` agent helps). Then:

- **Bump failed before pushing.** Nothing was tagged. Fix the cause through a
  PR into `dev` and merge the release PR again.
- **Build failed after the tag was pushed.** The tag and the bump commit are
  on `main`, and the release is at most a draft. If the cause was transient (a
  lost runner), re-run the failed jobs of the `Auto release` run. If it needs
  a code fix, delete the draft and the tag, land the fix through `dev`, then
  push the tag again on the fixed `main` commit; the tag trigger on
  `release.yml` builds it:

  ```bash
  gh release delete v<X.Y.Z> --yes      # the draft, if one was created
  git push origin --delete v<X.Y.Z>
  git fetch origin main && git tag -a v<X.Y.Z> origin/main -m "SQLPilot <X.Y.Z>"
  git push origin v<X.Y.Z>
  ```

  Pushing an existing tag again does nothing: GitHub does not re-trigger for
  a tag that already exists, which is why it is deleted first.
- **The release PR was squash-merged.** `auto-release.yml` stops with an
  error: commitizen would find no `fix:`/`feat:` commits, and `dev` and `main`
  no longer share history. Revert the squash commit on `main` through a PR
  from `dev`, then merge the release PR with a merge commit.
- **`dev` sync conflicted.** Merge `main` into `dev` by hand through a PR.

Never delete a published release or a tag of one: installed copies may
already have updated to it.

---

## Release workflow architecture

`release.yml` splits build from release creation to keep creation
single-sourced:

- `validate` job — `scripts/check-release-readiness.sh <tag version>` fails fast if the tag does not match the manifests.
- `integration-db` job — the `#[ignore]`d database tests against MySQL 8 and MariaDB 11, plus coverage. `build` depends on it, so a database regression blocks the release.
- `build` job (matrix of 4) — runs `tauri build` only, no release. Uploads bundles + `.sig` to the artifact store via `actions/upload-artifact`.
- `upload` job (single ubuntu-22.04) — writes the notes from `CHANGELOG.md`, downloads all build artifacts, then `softprops/action-gh-release` creates the draft release ONCE and uploads all assets.
- `generate-update-manifest` job runs after `upload` so `gh release download` sees the release. It runs [`scripts/build-update-manifest.sh`](../scripts/build-update-manifest.sh), uploads `latest.json`, then publishes the release. It has no signing key: it reads the `.sig` files the build produced.

Every job checks out the tag, not the commit that triggered the run: a called
run starts on the commit before the bump.

The four builds are Linux x86_64 (`.AppImage`, `.deb`, `.rpm`), Windows
x86_64 (`.msi`, `-setup.exe`, portable `SQLPilot.exe`), macOS Apple Silicon
and macOS Intel (`.dmg` and `.app.tar.gz` each), plus a `.sig` beside every
updater artifact and `latest.json`.

tauri-action's "build only" mode is achieved by omitting `tagName`, `releaseName`, and `releaseId` (per the action's README). The signing key is still passed to the build step because tauri itself signs during `tauri build` when `bundle.createUpdaterArtifacts: true`.

**Verify after each release.** Confirm exactly one release exists for the tag
and it has every asset:

```bash
gh release view v<X.Y.Z> --json isDraft,assets -q '{draft: .isDraft, assets: [.assets[].name]}'
gh api repos/EVWorth/sqlpilot/releases | \
  jq '[.[] | select(.tag_name == "v<X.Y.Z>")] | length'   # expect 1
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
