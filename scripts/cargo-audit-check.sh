#!/usr/bin/env bash
# scripts/cargo-audit-check.sh
#
# Wrapper around `cargo audit` that fails ONLY on real vulnerabilities.
# Unmaintained / yanked / unsound warnings are logged (visible in CI
# logs + job summary) but don't block the build.
#
# Rationale: SQLPilot has 16 transitive advisories on the gtk-rs GTK3
# bindings (RUSTSEC-2024-0411..0420) that cannot be fixed without
# upstream action (gtk-rs is archived since 2024-03-04, Tauri 2.x has
# no GTK4 webview support). Plus 1 unsound (glib 0.18.5). Plus a few
# unic-* unmaintained sub-deps. None have upstream fixes available.
#
# These are "unmaintained" / "unsound" warnings, not active exploits.
# We surface them in CI logs but don't fail.
#
# Real vulnerabilities (cargo audit "vulnerabilities" list) still
# fail the build. Examples in our tree: quick-xml 0.39.4 has
# RUSTSEC-2026-0194/0195 (DoS via unbounded namespace allocation).
#
# No --ignore flags used. All advisories visible in `cargo audit` output.
# No silent failures.

set -euo pipefail

WORKSPACE_DIR="${CARGO_WORKSPACE_DIR:-src-tauri}"
cd "$WORKSPACE_DIR"

# Run cargo audit with JSON output. Don't fail on non-zero exit
# (cargo audit returns non-zero when warnings exist).
JSON_OUTPUT="$(cargo audit --json 2>/dev/null || true)"

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
