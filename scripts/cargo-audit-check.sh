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

# Every tool this gate reads its answer through has to be present. A gate
# that cannot read its input must fail, not report success.
for tool in jq cargo-audit; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "::error::cargo-audit-check: '$tool' is not installed, so the audit cannot be read." >&2
    exit 2
  fi
done

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
AUDIT_STDERR="$(mktemp)"
trap 'rm -f "$AUDIT_STDERR"' EXIT
JSON_OUTPUT="$(cargo audit --json "${IGNORE_ARGS[@]}" 2>"$AUDIT_STDERR" || true)"

# The non-zero exit is ignored above, so check that a report actually came
# back. Without this, a cargo audit that failed outright (no advisory
# database, network error) produced empty output, every count below came out
# blank, and the script reported "0 real vulnerabilities".
if ! echo "$JSON_OUTPUT" | jq -e 'type == "object" and has("vulnerabilities")' >/dev/null 2>&1; then
  echo "::error::cargo audit did not produce a report; refusing to call this a pass." >&2
  cat "$AUDIT_STDERR" >&2
  exit 2
fi

# Say how fresh the advisory database is. cargo audit fetches it before each
# run, but a --no-fetch run or `fetch = false` in audit.toml answers from
# whatever copy is on disk, and an old copy reports clean.
DB_UPDATED="$(echo "$JSON_OUTPUT" | jq -r '.database."last-updated" // empty')"
if [ -z "$DB_UPDATED" ]; then
  echo "::warning::cargo-audit-check: the report does not say when the advisory database was last updated." >&2
elif DB_EPOCH="$(date -d "$DB_UPDATED" +%s 2>/dev/null)"; then
  DB_AGE_DAYS=$(( ($(date +%s) - DB_EPOCH) / 86400 ))
  echo "Advisory database last updated $DB_UPDATED ($DB_AGE_DAYS day(s) ago)."
  if [ "$DB_AGE_DAYS" -gt 7 ]; then
    echo "::warning::cargo-audit-check: the advisory database is $DB_AGE_DAYS days old, so newer advisories are not checked. Run without --no-fetch to update it." >&2
  fi
else
  # BSD date (macOS) has no -d; show the timestamp and let the reader judge.
  echo "Advisory database last updated $DB_UPDATED."
fi
echo ""

# Pretty-print the full advisory list to job logs (visible, not hidden).
echo "=== cargo audit findings ==="

# Parse first, then print: a parse failure must stop the gate, while the
# display pipeline below may legitimately end early (head closing the pipe).
if ! FINDINGS="$(echo "$JSON_OUTPUT" | jq -r '
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
')"; then
  echo "::error::cargo-audit-check: could not parse the cargo audit report; refusing to call this a pass." >&2
  exit 2
fi
if [ -n "$FINDINGS" ]; then
  printf '%s\n' "$FINDINGS" | column -t -s $'\t' 2>/dev/null | head -50 || true
fi

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
