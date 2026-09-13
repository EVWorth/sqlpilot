#!/usr/bin/env bash
# scripts/build-update-manifest.sh
#
# Build the `latest.json` that tauri-plugin-updater reads.
#
# Usage:
#   scripts/build-update-manifest.sh <version> <tag> <artifact-dir> [out-file]
#
# The updater looks up two keys per platform, in order (tauri-plugin-updater
# 2.10.1, `Update::download_url`): `{os}-{arch}-{installer}` for the format the
# running copy was installed from, then `{os}-{arch}` as a fallback. The
# installer names are appimage, deb, rpm, app, msi and nsis.
#
# So the suffixed keys are not decoration — they are how a .deb install finds
# a .deb and an .rpm install finds an .rpm, and the plugin installs those with
# `dpkg -i` and `rpm -U` through pkexec. #572 removed them on the reasoning
# that nothing reads them; that was wrong, and the evidence is a real 1.0.0
# log showing `Searching for updater target 'linux-x86_64-rpm'` immediately
# before an update that could not proceed.
#
# What stays true from #566/#567 is the other half: a key must point at
# something the updater for *that* format can apply. A .dmg cannot be applied
# by anything, so macOS gets the .app.tar.gz under both its keys.
#
#   linux-x86_64-appimage  .AppImage      linux-x86_64    .AppImage
#   linux-x86_64-deb       .deb
#   linux-x86_64-rpm       .rpm
#   windows-x86_64-msi     .msi           windows-x86_64  .msi
#   windows-x86_64-nsis    -setup.exe
#   darwin-x86_64-app      .app.tar.gz    darwin-x86_64   .app.tar.gz
#   darwin-aarch64-app     .app.tar.gz    darwin-aarch64  .app.tar.gz
#
# A package install on an image-based system (rpm-ostree, and anything else
# with a read-only /usr) cannot apply any of these, whatever the manifest
# says. That is the app's problem to explain, not this script's to solve.
#
# Every expected platform must be present. A missing artifact fails the
# release rather than quietly shipping a manifest that strands those users on
# their current version with no signal.
#
# Signatures come from the .sig files the build already produced. This script
# does not sign, and does not need the signing key.

set -euo pipefail

version="${1:?usage: build-update-manifest.sh <version> <tag> <artifact-dir> [out-file]}"
tag="${2:?missing tag}"
dir="${3:?missing artifact directory}"
out="${4:-latest.json}"

repo="${MANIFEST_REPO:-EVWorth/sqlpilot}"

# platform key : glob for the updater artifact
platforms=(
  "linux-x86_64:*_amd64.AppImage"
  "linux-x86_64-appimage:*_amd64.AppImage"
  "linux-x86_64-deb:*_amd64.deb"
  "linux-x86_64-rpm:*.x86_64.rpm"
  "windows-x86_64:*_x64_en-US.msi"
  "windows-x86_64-msi:*_x64_en-US.msi"
  "windows-x86_64-nsis:*_x64-setup.exe"
  "darwin-x86_64:*_x64.app.tar.gz"
  "darwin-x86_64-app:*_x64.app.tar.gz"
  "darwin-aarch64:*_aarch64.app.tar.gz"
  "darwin-aarch64-app:*_aarch64.app.tar.gz"
)

missing=()
entries=()

for spec in "${platforms[@]}"; do
  key="${spec%%:*}"
  glob="${spec#*:}"

  # Exactly one match, or the naming has changed under us and guessing which
  # one to ship is not a decision a release script should make.
  shopt -s nullglob
  # Deliberate: $glob is a pattern this script defines, and expanding it is
  # the point of the line.
  # shellcheck disable=SC2206
  matches=("$dir"/$glob)
  shopt -u nullglob

  if [ ${#matches[@]} -eq 0 ]; then
    missing+=("$key (no file matching $glob)")
    continue
  fi
  if [ ${#matches[@]} -gt 1 ]; then
    missing+=("$key (${#matches[@]} files match $glob: ${matches[*]##*/})")
    continue
  fi

  artifact="${matches[0]}"
  name="$(basename "$artifact")"
  sig="$artifact.sig"

  if [ ! -f "$sig" ]; then
    missing+=("$key ($name has no $name.sig beside it)")
    continue
  fi

  signature="$(cat "$sig")"
  if [ -z "$signature" ]; then
    missing+=("$key ($name.sig is empty)")
    continue
  fi

  entries+=("$key|https://github.com/$repo/releases/download/$tag/$name|$signature")
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "Cannot build the update manifest — these platforms have no usable artifact:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  echo >&2
  echo "Files present in $dir:" >&2
  ls -1 "$dir" >&2 || true
  exit 1
fi

# Assembled with python rather than string-concatenated, so a signature or a
# filename containing a quote cannot produce a file that is not valid JSON.
python3 - "$version" "$out" "${entries[@]}" <<'PY'
import json
import sys

version, out, *rows = sys.argv[1:]
platforms = {}
for row in rows:
    key, url, signature = row.split("|", 2)
    platforms[key] = {"url": url, "signature": signature}

# No min_app_version. Set to the previous tag it would strand anyone who
# skipped a release, with no signal to them at all (#568). A compatibility
# floor belongs here only when there is a real incompatibility to describe.
manifest = {
    "version": version,
    "notes": f"See https://github.com/{__import__('os').environ.get('MANIFEST_REPO', 'EVWorth/sqlpilot')}/releases/tag/v{version}",
    "pub_date": __import__("datetime").datetime.now(__import__("datetime").timezone.utc)
    .replace(microsecond=0)
    .isoformat()
    .replace("+00:00", "Z"),
    "platforms": platforms,
}
with open(out, "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
PY

# Read it back and check it says what it should. A manifest that parses but
# describes the wrong release is the failure this catches.
python3 - "$out" "$version" <<'PY'
import json
import sys

path, expected_version = sys.argv[1], sys.argv[2]
with open(path) as f:
    manifest = json.load(f)

problems = []
if manifest.get("version") != expected_version:
    problems.append(f"version is {manifest.get('version')!r}, expected {expected_version!r}")

# Every key the plugin looks up. Checked as a set rather than a count so
# that adding a platform to the table above without adding it here is a
# failure at release time rather than a gap a user finds later.
expected = {
    "linux-x86_64",
    "linux-x86_64-appimage",
    "linux-x86_64-deb",
    "linux-x86_64-rpm",
    "windows-x86_64",
    "windows-x86_64-msi",
    "windows-x86_64-nsis",
    "darwin-x86_64",
    "darwin-x86_64-app",
    "darwin-aarch64",
    "darwin-aarch64-app",
}
actual = set(manifest.get("platforms", {}))
if actual != expected:
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    problems.append(f"platforms missing {missing}, unexpected {extra}")

for key, entry in manifest.get("platforms", {}).items():
    if not entry.get("url", "").startswith("https://"):
        problems.append(f"{key}: url is not https")
    if not entry.get("signature"):
        problems.append(f"{key}: empty signature")

if problems:
    print("The generated manifest is not usable:", file=sys.stderr)
    for p in problems:
        print(f"  {p}", file=sys.stderr)
    sys.exit(1)
PY

echo "Wrote $out"
cat "$out"
