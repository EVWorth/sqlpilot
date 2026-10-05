#!/usr/bin/env bash
#
# Fail when a Tauri npm package and its Rust crate are on different
# major.minor releases.
#
# `tauri build` refuses to start when they disagree ("Found version mismatched
# Tauri packages"), but nothing on a pull request runs `tauri build`: it runs
# only in the release workflow. So a dependency PR that moves one side alone
# passes CI and breaks the next release, which is how
# @tauri-apps/plugin-updater 2.12 shipped against tauri-plugin-updater 2.11.
#
# The rule is the CLI's own: @tauri-apps/api pairs with the `tauri` crate, and
# @tauri-apps/plugin-<name> with tauri-plugin-<name>. Versions are the
# resolved ones, from package-lock.json and src-tauri/Cargo.lock, because that
# is what the CLI compares. A package with no counterpart on the other side
# (@tauri-apps/cli, say) is not a pair and is skipped.
#
# Usage: check-tauri-versions.sh [repo-root]

set -euo pipefail

root="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
npm_lock="$root/package-lock.json"
cargo_lock="$root/src-tauri/Cargo.lock"

command -v jq >/dev/null 2>&1 || { echo "check-tauri-versions: jq is not installed" >&2; exit 2; }
for f in "$npm_lock" "$cargo_lock"; do
  [[ -f "$f" ]] || { echo "check-tauri-versions: $f not found" >&2; exit 2; }
done

# "<npm name> <version>" for every top-level @tauri-apps package.
npm_versions="$(jq -r '
  .packages | to_entries[]
  | select(.key | test("^node_modules/@tauri-apps/[^/]+$"))
  | "\(.key | sub("^node_modules/"; "")) \(.value.version)"
' "$npm_lock")"

# Version of crate `$1` in Cargo.lock, empty when absent.
crate_version() {
  awk -v want="$1" '
    $0 == "[[package]]" { name = "" }
    $1 == "name" { gsub(/"/, "", $3); name = $3 }
    $1 == "version" && name == want { gsub(/"/, "", $3); print $3; exit }
  ' "$cargo_lock"
}

major_minor() { echo "$1" | cut -d. -f1,2; }

checked=0
mismatches=0
while read -r pkg version; do
  [[ -n "$pkg" ]] || continue
  case "$pkg" in
    @tauri-apps/api) crate=tauri ;;
    @tauri-apps/plugin-*) crate="tauri-plugin-${pkg#@tauri-apps/plugin-}" ;;
    *) continue ;;
  esac
  crate_ver="$(crate_version "$crate")"
  [[ -n "$crate_ver" ]] || continue
  checked=$((checked + 1))
  if [[ "$(major_minor "$version")" != "$(major_minor "$crate_ver")" ]]; then
    echo "::error::$pkg is $version but the $crate crate is $crate_ver; tauri build needs the same major.minor on both."
    mismatches=$((mismatches + 1))
  else
    echo "ok  $pkg $version = $crate $crate_ver"
  fi
done <<< "$npm_versions"

if [[ $checked -eq 0 ]]; then
  echo "::error::check-tauri-versions: found no Tauri package pairs to compare; the lockfiles are not what this script expects." >&2
  exit 2
fi
if [[ $mismatches -gt 0 ]]; then
  echo ""
  echo "Bump the other side to the same major.minor. Dependabot updates npm and cargo in separate PRs, so a Tauri bump on one side needs its partner."
  exit 1
fi
echo "All $checked Tauri package pairs agree."
