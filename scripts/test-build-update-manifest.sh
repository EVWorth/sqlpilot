#!/usr/bin/env bash
# scripts/test-build-update-manifest.sh
#
# Tests for build-update-manifest.sh.
#
# The manifest is the one artifact of a release that nothing downstream
# validates: a wrong entry does not fail the build, it fails on a user's
# machine, months later, as an update that never arrives. So the cases that
# matter most here are the refusals.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
builder="$script_dir/build-update-manifest.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

passed=0
failed=0

ok() { printf '  ok   %s\n' "$1"; passed=$((passed + 1)); }
bad() { printf '  FAIL %s\n     %s\n' "$1" "$2"; failed=$((failed + 1)); }

# The exact names the release actually publishes, taken from v1.0.0.
UPDATER_ARTIFACTS=(
  "SQLPilot_9.9.9_amd64.AppImage"
  "SQLPilot_9.9.9_amd64.deb"
  "SQLPilot-9.9.9-1.x86_64.rpm"
  "SQLPilot_9.9.9_x64_en-US.msi"
  "SQLPilot_9.9.9_x64-setup.exe"
  "SQLPilot_9.9.9_x64.app.tar.gz"
  "SQLPilot_9.9.9_aarch64.app.tar.gz"
)
# Published for humans, and not update sources: nothing can apply a .dmg.
OTHER_ARTIFACTS=(
  "SQLPilot_9.9.9_x64.dmg"
  "SQLPilot_9.9.9_aarch64.dmg"
)

# A release directory with everything present. $1 = directory.
seed() {
  local dir="$1"
  mkdir -p "$dir"
  local f
  for f in "${UPDATER_ARTIFACTS[@]}" "${OTHER_ARTIFACTS[@]}"; do
    echo "binary" > "$dir/$f"
    echo "signature-for-$f" > "$dir/$f.sig"
  done
}

case_dir() {
  local name="$1"
  local dir="$work/$name"
  seed "$dir"
  echo "$dir"
}

# --- a complete release ----------------------------------------------------
dir="$(case_dir complete)"
if "$builder" 9.9.9 v9.9.9 "$dir" "$dir/latest.json" >/dev/null 2>&1; then
  keys="$(python3 -c "import json,sys;print(' '.join(sorted(json.load(open(sys.argv[1]))['platforms'])))" "$dir/latest.json")"
  # Every key the plugin looks up: `{os}-{arch}-{installer}` for the format
  # the running copy came from, then `{os}-{arch}` as the fallback.
  expected="darwin-aarch64 darwin-aarch64-app darwin-x86_64 darwin-x86_64-app"
  expected="$expected linux-x86_64 linux-x86_64-appimage linux-x86_64-deb linux-x86_64-rpm"
  expected="$expected windows-x86_64 windows-x86_64-msi windows-x86_64-nsis"
  if [ "$keys" = "$expected" ]; then
    ok "emits every key the updater looks up"
  else
    bad "emits every key the updater looks up" "got: $keys"
  fi

  # The bug this table exists for: a .deb install looks up
  # `linux-x86_64-deb` before anything else, and finding nothing there sent
  # it to an AppImage it cannot apply.
  for pair in "linux-x86_64-deb:.deb" "linux-x86_64-rpm:.rpm" "windows-x86_64-nsis:-setup.exe"; do
    key="${pair%%:*}"
    want="${pair#*:}"
    url="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['platforms'][sys.argv[2]]['url'])" "$dir/latest.json" "$key")"
    case "$url" in
      *"$want") ok "$key points at the $want" ;;
      *) bad "$key points at the $want" "got: $url" ;;
    esac
  done

  # The heart of #566: macOS must point at the tarball, never the disk image.
  for key in darwin-x86_64 darwin-aarch64 darwin-x86_64-app darwin-aarch64-app; do
    url="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['platforms'][sys.argv[2]]['url'])" "$dir/latest.json" "$key")"
    case "$url" in
      *.app.tar.gz) ok "$key points at the .app.tar.gz" ;;
      *) bad "$key points at the .app.tar.gz" "got: $url" ;;
    esac
  done

  sig="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['platforms']['linux-x86_64']['signature'])" "$dir/latest.json")"
  if [ "$sig" = "signature-for-SQLPilot_9.9.9_amd64.AppImage" ]; then
    ok "takes each signature from the .sig beside its artifact"
  else
    bad "takes each signature from the .sig beside its artifact" "got: $sig"
  fi

  if python3 -c "
import json,sys
m = json.load(open(sys.argv[1]))
assert 'min_app_version' not in m, 'min_app_version should not be emitted'
" "$dir/latest.json"; then
    ok "emits no min_app_version"
  else
    bad "emits no min_app_version" "field present"
  fi
else
  bad "a complete release produces a manifest" "the script exited non-zero"
fi

# --- refusals --------------------------------------------------------------

# A missing updater artifact must stop the release. Shipping a manifest
# without a platform silently strands every user on it.
dir="$(case_dir missing-appimage)"
rm -f "$dir"/*.AppImage "$dir"/*.AppImage.sig
if out="$("$builder" 9.9.9 v9.9.9 "$dir" "$dir/latest.json" 2>&1)"; then
  bad "refuses a release with no AppImage" "it succeeded"
else
  case "$out" in
    *linux-x86_64*) ok "refuses a release with no AppImage, and names the platform" ;;
    *) bad "refuses a release with no AppImage, and names the platform" "message did not name it" ;;
  esac
fi

# The dmg is present and the tarball is not: the old mapping would have
# shipped the dmg. This must refuse instead of falling back to it.
dir="$(case_dir dmg-without-tarball)"
rm -f "$dir"/*.app.tar.gz "$dir"/*.app.tar.gz.sig
if "$builder" 9.9.9 v9.9.9 "$dir" "$dir/latest.json" >/dev/null 2>&1; then
  bad "does not fall back to the .dmg" "it succeeded with only a dmg present"
else
  ok "does not fall back to the .dmg"
fi

# An artifact with no signature cannot be verified by the client, so a
# manifest entry for it is worse than none.
dir="$(case_dir missing-signature)"
rm -f "$dir/SQLPilot_9.9.9_amd64.AppImage.sig"
if "$builder" 9.9.9 v9.9.9 "$dir" "$dir/latest.json" >/dev/null 2>&1; then
  bad "refuses an artifact with no signature" "it succeeded"
else
  ok "refuses an artifact with no signature"
fi

dir="$(case_dir empty-signature)"
: > "$dir/SQLPilot_9.9.9_amd64.AppImage.sig"
if "$builder" 9.9.9 v9.9.9 "$dir" "$dir/latest.json" >/dev/null 2>&1; then
  bad "refuses an empty signature" "it succeeded"
else
  ok "refuses an empty signature"
fi

# Two files match one glob: the naming has changed and picking one is not a
# decision a release script should make on its own.
dir="$(case_dir ambiguous)"
cp "$dir/SQLPilot_9.9.9_amd64.AppImage" "$dir/SQLPilot_9.9.10_amd64.AppImage"
cp "$dir/SQLPilot_9.9.9_amd64.AppImage.sig" "$dir/SQLPilot_9.9.10_amd64.AppImage.sig"
if "$builder" 9.9.9 v9.9.9 "$dir" "$dir/latest.json" >/dev/null 2>&1; then
  bad "refuses an ambiguous match rather than guessing" "it succeeded"
else
  ok "refuses an ambiguous match rather than guessing"
fi

# --- output shape ----------------------------------------------------------
dir="$(case_dir json-shape)"
"$builder" 1.2.3 v1.2.3 "$dir" "$dir/latest.json" >/dev/null 2>&1
if python3 -c "
import json,sys
m = json.load(open(sys.argv[1]))
assert m['version'] == '1.2.3', m['version']
assert all(p['url'].startswith('https://') for p in m['platforms'].values())
assert all(p['signature'] for p in m['platforms'].values())
assert m['pub_date'].endswith('Z')
" "$dir/latest.json"; then
  ok "the manifest is valid JSON with the version it was given"
else
  bad "the manifest is valid JSON with the version it was given" "assertion failed"
fi

echo
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
