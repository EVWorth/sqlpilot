#!/usr/bin/env bash
# scripts/build-update-manifest.sh
#
# Build the `latest.json` that tauri-plugin-updater reads.
#
# Usage:
#   scripts/build-update-manifest.sh <version> <tag> <artifact-dir> [out-file]
#
# The updater looks up exactly one key per platform, of the form
# {os}-{arch}, and each platform accepts exactly one artifact format:
#
#   linux-x86_64     .AppImage      (the Linux updater handles no other format)
#   windows-x86_64   .msi
#   darwin-x86_64    .app.tar.gz    (a .dmg is a distribution format the
#   darwin-aarch64   .app.tar.gz     updater cannot apply)
#
# Anything else the release publishes — .deb, .rpm, .dmg, the NSIS installer,
# the portable .exe — is a download for humans, not an update source. Listing
# them under invented keys like `linux-deb` made the manifest read as though
# they were covered when nothing reads those entries (#566, #567).
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
  "windows-x86_64:*_x64_en-US.msi"
  "darwin-x86_64:*_x64.app.tar.gz"
  "darwin-aarch64:*_aarch64.app.tar.gz"
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

expected = {"linux-x86_64", "windows-x86_64", "darwin-x86_64", "darwin-aarch64"}
actual = set(manifest.get("platforms", {}))
if actual != expected:
    problems.append(f"platforms are {sorted(actual)}, expected {sorted(expected)}")

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
