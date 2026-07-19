#!/usr/bin/env bash
# scripts/check-release-readiness.sh
#
# Verify the working tree is ready for a version cut + tag push.
# Compares manifest versions against each other and (optionally) against an
# expected tag. Catches the class of bug where a tag points at code whose
# manifests don't match.
#
# Usage:
#   scripts/check-release-readiness.sh           # use git describe to detect tag
#   scripts/check-release-readiness.sh 0.3.5     # check against explicit version
#   scripts/check-release-readiness.sh --strict  # also require working tree clean + on main
#
# Exit codes:
#   0  - ready
#   1  - manifests disagree with each other
#   2  - manifests disagree with expected tag
#   3  - working tree dirty (--strict only)
#   4  - not on main (--strict only)

set -euo pipefail

REPO_DIR="${SQLPILOT_REPO_DIR:-$(pwd)}"
STRICT=false
EXPECTED_VERSION=""

# Parse args
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=true ;;
    --help|-h)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    -*) echo "Unknown flag: $arg" >&2; exit 1 ;;
    *) EXPECTED_VERSION="$arg" ;;
  esac
done

cd "$REPO_DIR"

# Read versions from manifests
JS_VER="$(node -p "require('./package.json').version")"
RS_VER="$(grep '^version' src-tauri/Cargo.toml | head -1 | sed 's/.*"\(.*\)".*/\1/')"
TA_VER="$(node -p "require('./src-tauri/tauri.conf.json').version")"

# If no expected version provided, default to manifest version.
# We intentionally don't auto-detect from `git describe` because lightweight
# tags on non-first-parent merges are unreliable (returns oldest ancestor).
# Pass an explicit version to validate against an upcoming tag.
if [ -z "$EXPECTED_VERSION" ]; then
  EXPECTED_VERSION="$JS_VER"
fi

echo "Manifest versions:"
echo "  package.json:       $JS_VER"
echo "  Cargo.toml:         $RS_VER"
echo "  tauri.conf.json:    $TA_VER"
if [ -n "$EXPECTED_VERSION" ]; then
  echo "  expected (tag):     v$EXPECTED_VERSION"
fi
echo

# Check manifests agree with each other
if [ "$JS_VER" != "$RS_VER" ] || [ "$JS_VER" != "$TA_VER" ]; then
  echo "FAIL: manifests disagree"
  echo "  All three must match before any release cut."
  echo "  Run: make bump patch   # or minor/major"
  exit 1
fi

# Check against tag if provided
if [ -n "$EXPECTED_VERSION" ] && [ "$JS_VER" != "$EXPECTED_VERSION" ]; then
  echo "FAIL: manifests ($JS_VER) don't match expected tag (v$EXPECTED_VERSION)"
  echo "  Either bump manifests OR use the right tag."
  exit 2
fi

# Strict mode: also check working tree + branch
if [ "$STRICT" = true ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "FAIL: working tree dirty"
    git status --short | sed 's/^/  /'
    exit 3
  fi

  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$BRANCH" != "main" ]; then
    echo "FAIL: not on main (on $BRANCH)"
    exit 4
  fi
fi

echo "OK: ready for release (manifests agree${EXPECTED_VERSION:+, match tag v$EXPECTED_VERSION}${STRICT:+, tree clean, on main})"
exit 0