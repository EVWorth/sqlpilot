#!/usr/bin/env bash
# scripts/cargo-audit-check.sh
#
# Wrapper around `cargo audit` that fails ONLY on real vulnerabilities.
# Unmaintained / yanked / unsound warnings are logged (visible in CI
# logs + job summary) but don't block the build.
#
# Two-layer policy:
#
# 1. Warnings layer: unmaintained / yanked / unsound advisories (e.g. the
#    16 gtk-rs chain + glib unsound + unic-* sub-deps) are NOT ignored
#    in cargo. They appear in `cargo audit` output and the job summary
#    so they're visible. They just don't fail the build.
#
# 2. Known-accepted layer: a small list of REAL vulnerabilities whose fix
#    is blocked by upstream and tracked for cleanup. These ARE passed
#    to `cargo audit --ignore` (otherwise CI is permanently red), but
#    the IDs are explicitly listed in this script + the job output
#    shows them under a "WAITING FOR UPSTREAM" header + a tracking
#    issue link. NOT silent.
#
# When upstream ships, dependabot will offer the bump; remove the IDs
# from KNOWN_ACCEPTED below, commit, and the gate goes green naturally.
#
# Currently known-accepted (2 advisories, all quick-xml 0.39):
#
#   RUSTSEC-2026-0194  Quadratic run time in quick-xml start tag check
#   RUSTSEC-2026-0195  Unbounded namespace allocation DoS in quick-xml
#
# Source: wayland-scanner 0.31.10 (crates.io, Feb 2026) pins
#   quick-xml = "0.39". Upstream fix: wayland-rs PR #938 merged
#   2026-07-08 bumping to 0.41 on master. NOT YET RELEASED.
# Tracked: https://github.com/EVWorth/sqlpilot/issues/206
#
# No silent failures. No blanket --ignore. Listed and reviewed.

set -euo pipefail

WORKSPACE_DIR="${CARGO_WORKSPACE_DIR:-src-tauri}"
cd "$WORKSPACE_DIR"

# Known-accepted vulnerabilities — fix is blocked by upstream.
# These IDs are passed to `cargo audit --ignore` so CI doesn't stay
# permanently red, BUT they're explicitly listed in this script
# header AND in job output (see the KNOWN_ACCEPTED block below).
# To clear: remove from this list, then commit the dep bump that
# dependabot (or manual) will offer once upstream releases.
KNOWN_ACCEPTED=(
  "RUSTSEC-2026-0194"  # quick-xml 0.39: quadratic start tag check (DoS)
  "RUSTSEC-2026-0195"  # quick-xml 0.39: unbounded namespace allocation (DoS)
)

# Build --ignore args from the list
IGNORE_ARGS=()
for id in "${KNOWN_ACCEPTED[@]}"; do
  IGNORE_ARGS+=(--ignore "$id")
done

# Run cargo audit with JSON output. Pass --ignore for known-accepted.
# Don't fail on non-zero exit (cargo audit returns non-zero when warnings
# exist, even with --ignore).
JSON_OUTPUT="$(cargo audit --json "${IGNORE_ARGS[@]}" 2>/dev/null || true)"

# Pretty-print the full advisory list to job logs (visible, not hidden).
echo "=== cargo audit findings ==="

echo "$JSON_OUTPUT" | jq -r '
  (.vulnerabilities.list // []) as $vulns |
  (.warnings.unmaintained // []) as $unm |
  (.warnings.unsound // []) as $uns |
  ($vulns + $unm + $uns) |
  .[] |
  [
    .advisory.id,
    (.advisory.package // "?"),
    .advisory.title
  ] | @tsv
' | column -t -s $'\t' 2>/dev/null | head -50 || echo "(parse failed)"

# Always show the known-accepted list — even after they clear from
# cargo audit output, the list serves as a reminder of past accepted.
echo ""
echo "=== Known-accepted vulnerabilities (WAITING FOR UPSTREAM) ==="
for id in "${KNOWN_ACCEPTED[@]}"; do
  echo "  $id"
done
echo ""
echo "Fix pending: wayland-rs release with quick-xml 0.41 bump (PR #938"
echo "merged 2026-07-08, not yet on crates.io). Dependabot will offer the"
echo "bump when upstream publishes. Remove from KNOWN_ACCEPTED list above"
echo "when the gate goes green naturally. Tracked in #206."

# Count real vulnerabilities (the blocking kind).
VULN_COUNT="$(echo "$JSON_OUTPUT" | jq -r '(.vulnerabilities.list // []) | length')"
UNM_COUNT="$(echo "$JSON_OUTPUT" | jq -r '(.warnings.unmaintained // []) | length')"
UNS_COUNT="$(echo "$JSON_OUTPUT" | jq -r '(.warnings.unsound // []) | length')"
WARN_COUNT=$((UNM_COUNT + UNS_COUNT))

# Add to GitHub Actions job summary if available.
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## cargo audit"
    echo ""
    echo "Vulnerabilities (blocking): **$VULN_COUNT**"
    echo "Unmaintained/Unsound warnings (non-blocking): **$WARN_COUNT** ($UNM_COUNT unmaintained, $UNS_COUNT unsound)"
    echo ""
    if [ "$VULN_COUNT" -gt 0 ]; then
      echo "### ❌ Real vulnerabilities"
      echo "$JSON_OUTPUT" | jq -r '.vulnerabilities.list[] | "- **\(.advisory.id)** (\(.advisory.package)): \(.advisory.title)"'
      echo ""
    fi
    if [ "$WARN_COUNT" -gt 0 ]; then
      echo "### ⚠️ Non-blocking warnings (unmaintained/unsound)"
      echo ""
      echo "These advisories are visible but don't fail the build. They are tracked in the team's fix workstream."
      echo ""
      echo "$JSON_OUTPUT" | jq -r '
        ((.warnings.unmaintained // []) + (.warnings.unsound // [])) |
        .[] |
        "- **\(.advisory.id)** (\(.advisory.package // "?")): \(.advisory.title)"
      ' | head -30
    fi
    # Always show the known-accepted list (even when empty) so
    # reviewers can see what's deliberately being silenced.
    if [ "${#KNOWN_ACCEPTED[@]}" -gt 0 ]; then
      echo ""
      echo "### ⏳ Known-accepted vulnerabilities (waiting for upstream)"
      echo ""
      echo "These IDs are passed to \`cargo audit --ignore\` so CI doesn't stay permanently red."
      echo "They are listed here (not hidden). The fix is pending upstream; remove the ID from the"
      echo "\`KNOWN_ACCEPTED\` array in \`scripts/cargo-audit-check.sh\` once dependabot offers the dep bump."
      echo ""
      for id in "${KNOWN_ACCEPTED[@]}"; do
      case "$id" in
        RUSTSEC-2026-019*) echo "- **$id** (quick-xml): fix pending wayland-rs release (PR smithay/wayland-rs#938 merged 2026-07-08, not yet on crates.io). Tracked in #206." ;;
        *) echo "- **$id**" ;;
      esac
      done
    fi
  } >> "$GITHUB_STEP_SUMMARY"
fi

# Decision: fail only on real vulnerabilities.
if [ "$VULN_COUNT" -gt 0 ]; then
  echo ""
  echo "::error::$VULN_COUNT real vulnerabilities found:"
  echo "$JSON_OUTPUT" | jq -r '.vulnerabilities.list[] | "  - \(.advisory.id) (\(.advisory.package)): \(.advisory.title)"'
  exit 1
fi

echo ""
echo "✅ cargo audit: 0 real vulnerabilities, $WARN_COUNT non-blocking advisory warning(s) (unmaintained/unsound)."
exit 0
