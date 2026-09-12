#!/usr/bin/env bash
# scripts/test-check-action-pins.sh
#
# Tests for check-action-pins.sh.
#
# The offline half — pin shape — is what runs everywhere, so it is what is
# tested here: a workflow directory is built per case and the checker is
# pointed at it. The online half (does the commit exist, does the comment's
# version agree with it) needs the API and is exercised by CI running the
# real check against this repo's own workflows.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checker="$script_dir/check-action-pins.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

passed=0
failed=0
ok() { printf '  ok   %s\n' "$1"; passed=$((passed + 1)); }
bad() { printf '  FAIL %s\n     %s\n' "$1" "$2"; failed=$((failed + 1)); }

# Run the checker over a workflow file containing `$2`, offline.
run_case() {
  local name="$1" content="$2"
  local dir="$work/$name"
  mkdir -p "$dir/.github/workflows"
  printf '%s\n' "$content" > "$dir/.github/workflows/test.yml"
  (cd "$dir" && "$checker" --offline 2>&1)
}

expect_pass() {
  local name="$1" content="$2" output status
  output=$(run_case "$name" "$content") && status=0 || status=$?
  if [[ $status -eq 0 ]]; then ok "$name"; else bad "$name" "$output"; fi
}

expect_fail() {
  local name="$1" content="$2" needle="$3" output status
  output=$(run_case "$name" "$content") && status=0 || status=$?
  if [[ $status -eq 0 ]]; then
    bad "$name" "expected a failure, got a pass"
  elif [[ "$output" != *"$needle"* ]]; then
    bad "$name" "expected the message to mention '$needle', got: $output"
  else
    ok "$name"
  fi
}

sha40="3d3c42e5aac5ba805825da76410c181273ba90b1"

echo "check-action-pins.sh"

expect_pass "a full SHA passes" \
  "      - uses: actions/checkout@$sha40 # v7.0.1"

expect_pass "a pin with no version comment passes" \
  "      - uses: actions/checkout@$sha40"

expect_fail "a version tag is refused" \
  "      - uses: actions/checkout@v4" \
  "MALFORMED"

expect_fail "a branch name is refused" \
  "      - uses: actions/checkout@main" \
  "MALFORMED"

expect_fail "a short SHA is refused" \
  "      - uses: actions/checkout@3d3c42e" \
  "MALFORMED"

# The bug that motivated the script: 41 characters, matching no commit, which
# GitHub rejects before any step runs (#534).
expect_fail "a 41-character SHA is refused" \
  "      - uses: actions/checkout@${sha40}a" \
  "MALFORMED"

expect_fail "no ref at all is refused" \
  "      - uses: actions/checkout" \
  "UNPINNED"

expect_pass "a local action is not checked" \
  "      - uses: ./.github/actions/setup"

expect_pass "a docker reference is not checked" \
  "      - uses: docker://alpine:3.20"

expect_pass "an action in a subdirectory passes" \
  "      - uses: owner/repo/sub/action@$sha40 # v1.2.3"

# The comment is parsed off before the shape check; a note after the version
# must not make the pin look malformed.
expect_pass "a comment with a note after the version passes" \
  "      - uses: actions/checkout@$sha40 # v7.0.1 (pinned by hand)"

expect_pass "a file with no actions at all passes" \
  "name: nothing
on: push"

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ $failed -eq 0 ]]
